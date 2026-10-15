-- ============================================================
-- 수업 응답 웹앱 · 버전 2 · Supabase 설정
-- 교사(선생님)와 학생만 쓰는 판. 교사는 맨 아래에 적은 이메일로 로그인한다.
-- Supabase 대시보드 → SQL Editor 에 이 파일 전체를 붙여넣고 Run. 여러 번 실행해도 괜찮습니다.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- 교사 목록: 여기에 있는 이메일로 로그인한 사람만 교사 화면을 쓸 수 있다.
create table if not exists teachers (
  email text primary key
);

-- 수업(반) 하나. 수업 코드는 서버가 겹치지 않게 만든다.
create table if not exists lessons (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid(),
  code        text not null check (code ~ '^[A-Z0-9]{4,12}$'),
  title       text not null check (length(title) <= 100),
  slide_dir   text not null default '' check (length(slide_dir) <= 500),   -- 슬라이드 그림 주소({n} = 쪽 번호)
  slide_count int  not null default 0 check (slide_count between 0 and 300),
  page        int  not null default 1,
  open        boolean not null default true,
  created_at  timestamptz not null default now()
);
-- 나중에 더한 칸: 수업 종류(슬라이드 수업 / 설문만)
alter table lessons add column if not exists kind text not null default 'lesson' check (kind in ('lesson', 'survey'));
create unique index if not exists lessons_code_key on lessons (code);
create index if not exists lessons_owner on lessons (owner);

create table if not exists activities (
  id          uuid primary key default gen_random_uuid(),
  lesson_id   uuid not null references lessons(id) on delete cascade,
  kind        text not null check (kind in ('slide', 'survey', 'quiz')),
  title       text not null check (length(title) <= 100),
  page        int,
  show_answer boolean not null default true,
  named       boolean not null default false,
  shared      boolean not null default false,
  questions   jsonb not null default '[]' check (octet_length(questions::text) <= 50000),
  sort        int not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists activities_lesson on activities (lesson_id);
-- 나중에 더한 칸: 여러 쪽에 걸친 질문의 끝 쪽(비우면 page 한 쪽)
alter table activities add column if not exists page_to int;
-- 나중에 더한 칸: 시뮬레이션(html 한 파일)과 '슬라이드 자리에 띄우기'
alter table activities add column if not exists html text;
alter table activities add column if not exists sim_full boolean not null default false;
alter table activities drop constraint if exists activities_kind_check;
alter table activities add constraint activities_kind_check check (kind in ('slide', 'survey', 'quiz', 'sim'));
alter table activities drop constraint if exists activities_html_size;
alter table activities add constraint activities_html_size check (html is null or length(html) <= 500000);

-- 학생: 웹앱 전체에 한 명당 하나(학번 + 이름 + 4자리 비밀번호). 어느 수업에 들어와도 같은 비밀번호를 쓴다.
create table if not exists students (
  id           uuid primary key default gen_random_uuid(),
  class_no     text not null,        -- 학번
  name         text not null,
  pin_hash     text,                 -- 비어 있으면 다음에 들어올 때 새로 정한다(처음, 또는 교사가 초기화)
  pin_set      boolean generated always as (pin_hash is not null) stored,
  token        text unique,          -- 입장한 기기가 쓰는 열쇠. 초기화하면 지워져 모든 기기가 나가진다
  fails        int not null default 0,
  locked_until timestamptz,
  created_at   timestamptz not null default now()
);
alter table students add column if not exists last_seen timestamptz;

-- 수업 참여: 학생이 어느 수업에 들어왔는지, 그 수업 화면을 마지막으로 연 때(교사 화면의 '접속 중')
create table if not exists lesson_students (
  lesson_id  uuid not null references lessons(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  last_seen  timestamptz,
  primary key (lesson_id, student_id)
);
create index if not exists lesson_students_student on lesson_students (student_id);

create table if not exists responses (
  student_id  uuid not null references students(id) on delete cascade,
  activity_id uuid not null references activities(id) on delete cascade,
  answers     jsonb not null default '{}',
  score       int,
  total       int,
  updated_at  timestamptz not null default now(),
  primary key (student_id, activity_id)
);
create index if not exists responses_activity on responses (activity_id);

-- 예전 구조(수업마다 학생이 따로)에서 옮기기. 이미 새 구조면 아무것도 하지 않는다.
-- 같은 학번+이름은 한 명으로 합치고, 가장 최근에 들어온 기록의 비밀번호를 쓴다. 응답은 모두 그 학생에게 옮긴다.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'students' and column_name = 'lesson_id') then
    drop table if exists pg_temp.keep_students;
    create temp table keep_students as
      select id, first_value(id) over (partition by class_no, name
                                       order by coalesce(last_seen, created_at) desc, created_at desc) as keep_id
      from students;
    insert into lesson_students (lesson_id, student_id, joined_at, last_seen)
      select s.lesson_id, k.keep_id, s.created_at, s.last_seen
      from students s join keep_students k on k.id = s.id
      on conflict (lesson_id, student_id) do nothing;
    update responses r set student_id = k.keep_id
      from keep_students k where r.student_id = k.id and k.id <> k.keep_id;
    delete from students s using keep_students k where s.id = k.id and k.id <> k.keep_id;
    alter table students drop column lesson_id;   -- 수업별 제약도 함께 없어진다
    drop table pg_temp.keep_students;
  end if;
end $$;
create unique index if not exists students_who on students (class_no, name);

-- ------------------------------------------------------------
-- 보안(RLS): 표는 교사만 직접 읽고 쓴다. 학생은 아래 함수 세 개(입장, 상태, 저장)로만 들어온다.
-- ------------------------------------------------------------
alter table teachers   enable row level security;
alter table lessons    enable row level security;
alter table activities enable row level security;
alter table students   enable row level security;
alter table responses  enable row level security;
alter table lesson_students enable row level security;

create or replace function is_teacher() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from teachers where email = lower(auth.jwt() ->> 'email'))
$$;

drop policy if exists teacher_all on lessons;
drop policy if exists teacher_all on activities;
drop policy if exists teacher_all on students;
drop policy if exists teacher_all on responses;
drop policy if exists teacher_all on lesson_students;
create policy teacher_all on lessons    for all to authenticated using (is_teacher()) with check (is_teacher());
create policy teacher_all on activities for all to authenticated using (is_teacher()) with check (is_teacher());
create policy teacher_all on students   for all to authenticated using (is_teacher()) with check (is_teacher());
create policy teacher_all on responses  for all to authenticated using (is_teacher()) with check (is_teacher());
create policy teacher_all on lesson_students for all to authenticated using (is_teacher()) with check (is_teacher());

-- 새 수업 만들기: 겹치지 않는 수업 코드를 서버가 정한다(헷갈리는 0, O, 1, I 는 쓰지 않음)
-- p_kind: 'lesson'(슬라이드 수업) 또는 'survey'(설문만)
drop function if exists create_lesson(text);
create or replace function create_lesson(p_title text, p_kind text default 'lesson')
returns lessons language plpgsql security definer set search_path = public, extensions as $$
declare
  c text;
  l lessons;
  letters text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  if not is_teacher() then raise exception 'not a teacher'; end if;
  if coalesce(trim(p_title), '') = '' or length(p_title) > 100 then raise exception 'bad title'; end if;
  loop
    select string_agg(substr(letters, 1 + (get_byte(b, i) % length(letters)), 1), '')
      into c from (select gen_random_bytes(5) b) x, generate_series(0, 4) i;
    begin
      insert into lessons (owner, code, title, kind)
        values (auth.uid(), c, trim(p_title), case when p_kind = 'survey' then 'survey' else 'lesson' end) returning * into l;
      return l;
    exception when unique_violation then
      -- 드물게 겹치면 다시 뽑는다
    end;
  end loop;
end $$;

-- ------------------------------------------------------------
-- 학생용 함수 (class-response-app 과 같음)
-- ------------------------------------------------------------
create or replace function tidy(t text) returns text
language sql immutable as $$ select regexp_replace(coalesce(t, ''), '\s', '', 'g') $$;

-- 학생 입장: 학번+이름+비밀번호로 확인하고 이 수업에 참여시킨다.
-- 처음이거나 초기화된 학생은 p_confirm = true 로 다시 불러야 비밀번호가 정해진다. 5번 틀리면 10분 잠금.
create or replace function student_enter(p_code text, p_class_no text, p_name text, p_pin text, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  l lessons;
  s students;
  c text := tidy(p_class_no);
  n text := tidy(p_name);
  existed boolean;
begin
  select * into l from lessons where code = upper(tidy(p_code));
  if not found then return jsonb_build_object('error', 'no_lesson'); end if;
  if c = '' or n = '' or length(c) > 20 or length(n) > 20 then return jsonb_build_object('error', 'bad_name'); end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then return jsonb_build_object('error', 'bad_pin'); end if;

  select * into s from students where class_no = c and name = n for update;
  existed := found;

  if not existed or s.pin_hash is null then
    if not p_confirm then return jsonb_build_object('error', 'need_confirm', 'reset', existed); end if;
    if not existed then
      if (select count(*) from students) >= 5000 then return jsonb_build_object('error', 'full'); end if;
      insert into students (class_no, name) values (c, n) returning * into s;
    end if;
    update students
      set pin_hash = crypt(p_pin, gen_salt('bf')), fails = 0, locked_until = null,
          token = coalesce(token, encode(gen_random_bytes(24), 'hex'))
      where id = s.id returning * into s;
  else
    if s.locked_until > now() then
      return jsonb_build_object('error', 'locked', 'minutes', ceil(extract(epoch from s.locked_until - now()) / 60));
    end if;
    if s.pin_hash <> crypt(p_pin, s.pin_hash) then
      if s.fails + 1 >= 5 then
        update students set fails = 0, locked_until = now() + interval '10 minutes' where id = s.id;
        return jsonb_build_object('error', 'locked', 'minutes', 10);
      end if;
      update students set fails = fails + 1 where id = s.id;
      return jsonb_build_object('error', 'wrong_pin', 'left', 4 - s.fails);
    end if;
    update students
      set fails = 0, locked_until = null, token = coalesce(token, encode(gen_random_bytes(24), 'hex'))
      where id = s.id returning * into s;
  end if;

  if not exists (select 1 from lesson_students where lesson_id = l.id and student_id = s.id) then
    if (select count(*) from lesson_students where lesson_id = l.id) >= 200 then return jsonb_build_object('error', 'full'); end if;
    insert into lesson_students (lesson_id, student_id) values (l.id, s.id) on conflict do nothing;
  end if;
  return jsonb_build_object('token', s.token, 'class_no', s.class_no, 'name', s.name, 'code', l.code);
end $$;

-- 학생 화면에 필요한 것 전부: 이 수업의 상태, 활동, 내 응답, 공개된 친구들 응답.
-- 이미 입장한 학생(열쇠가 있는 기기)이 새 수업 코드로 오면 비밀번호 없이 그 수업에 참여시킨다.
drop function if exists student_state(text);
create or replace function student_state(p_token text, p_code text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  s students;
  l lessons;
  m lesson_students;
begin
  select * into s from students where token = p_token and p_token is not null;
  if not found then return jsonb_build_object('error', 'logged_out'); end if;
  select * into l from lessons where code = upper(tidy(p_code));
  if not found then return jsonb_build_object('error', 'no_lesson'); end if;
  select * into m from lesson_students where lesson_id = l.id and student_id = s.id;
  if not found then
    if (select count(*) from lesson_students where lesson_id = l.id) >= 200 then return jsonb_build_object('error', 'full'); end if;
    insert into lesson_students (lesson_id, student_id) values (l.id, s.id) on conflict do nothing returning * into m;
  end if;
  -- 접속 중 표시: 10초에 한 번만 적는다
  if m.last_seen is null or m.last_seen < now() - interval '10 seconds' then
    update lesson_students set last_seen = now() where lesson_id = l.id and student_id = s.id;
  end if;

  return jsonb_build_object(
    'me', jsonb_build_object('class_no', s.class_no, 'name', s.name),
    'lesson', jsonb_build_object('code', l.code, 'title', l.title, 'slide_dir', l.slide_dir,
                                 'slide_count', l.slide_count, 'page', l.page, 'open', l.open, 'kind', l.kind),
    'activities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'kind', a.kind, 'title', a.title, 'page', a.page, 'page_to', a.page_to, 'named', a.named, 'shared', a.shared,
        'sim_full', a.sim_full, 'html_ver', case when a.kind = 'sim' then md5(coalesce(a.html, '')) end,
        'questions', case
          when a.kind = 'quiz' and a.show_answer and r.student_id is not null then a.questions
          else (select coalesce(jsonb_agg(q - 'answer' - 'explain'), '[]'::jsonb) from jsonb_array_elements(a.questions) q)
        end,
        'mine', r.answers, 'score', r.score, 'total', r.total, 'saved_at', r.updated_at,
        'others', case when a.shared then (
          select coalesce(jsonb_agg(jsonb_build_object(
                   'name', case when a.named then o.class_no || ' ' || o.name end,
                   'answers', x.answers) order by x.updated_at), '[]'::jsonb)
          from responses x join students o on o.id = x.student_id
          where x.activity_id = a.id) end
      ) order by a.page nulls last, a.sort, a.created_at)
      from activities a
      left join responses r on r.activity_id = a.id and r.student_id = s.id
      where a.lesson_id = l.id), '[]'::jsonb)
  );
end $$;

-- 학생 응답 저장. 그 수업에 참여한 학생만, 제출이 열려 있을 때만. 퀴즈는 한 번만 제출하고 서버에서 채점한다.
create or replace function student_save(p_token text, p_activity uuid, p_answers jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s students;
  l lessons;
  a activities;
  sc int;
  tot int;
begin
  select * into s from students where token = p_token and p_token is not null;
  if not found then return jsonb_build_object('error', 'logged_out'); end if;
  select * into a from activities where id = p_activity;
  if not found or a.kind = 'sim' or not exists (select 1 from lesson_students where lesson_id = a.lesson_id and student_id = s.id) then
    return jsonb_build_object('error', 'no_activity');
  end if;
  select * into l from lessons where id = a.lesson_id;
  if not l.open then return jsonb_build_object('error', 'closed'); end if;
  if jsonb_typeof(p_answers) is distinct from 'object' or octet_length(p_answers::text) > 20000 then
    return jsonb_build_object('error', 'too_big');
  end if;

  if a.kind = 'quiz' then
    if exists (select 1 from responses where student_id = s.id and activity_id = a.id) then
      return jsonb_build_object('error', 'already');
    end if;
    select count(*) filter (where q ? 'answer'),
           count(*) filter (where q ? 'answer' and p_answers -> (q ->> 'id') = q -> 'answer')
      into tot, sc
      from jsonb_array_elements(a.questions) q;
  end if;

  insert into responses (student_id, activity_id, answers, score, total, updated_at)
    values (s.id, a.id, p_answers, sc, tot, now())
    on conflict (student_id, activity_id)
    do update set answers = excluded.answers, score = excluded.score, total = excluded.total, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- 시뮬레이션 html: 크기가 커서 3초마다 받는 상태에는 넣지 않고, 바뀌었을 때(html_ver)만 이것으로 한 번 받는다
create or replace function student_sim(p_token text, p_activity uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  s students;
  a activities;
begin
  select * into s from students where token = p_token and p_token is not null;
  if not found then return null; end if;
  select * into a from activities where id = p_activity and kind = 'sim';
  if not found or not exists (select 1 from lesson_students where lesson_id = a.lesson_id and student_id = s.id) then return null; end if;
  return a.html;
end $$;

-- 교사 화면: 이 수업에 들어온 학생 목록(비밀번호 대신 '정해졌는지'만)
create or replace function teacher_students(p_lesson uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_teacher() then raise exception 'not a teacher'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'class_no', s.class_no, 'name', s.name, 'pin_set', s.pin_set, 'fails', s.fails,
      'locked_until', s.locked_until, 'created_at', s.created_at, 'joined_at', m.joined_at, 'last_seen', m.last_seen))
    from lesson_students m join students s on s.id = m.student_id
    where m.lesson_id = p_lesson), '[]'::jsonb);
end $$;

revoke all on function student_enter(text, text, text, text, boolean) from public;
revoke all on function student_state(text, text) from public;
revoke all on function teacher_students(uuid) from public;
revoke all on function student_sim(text, uuid) from public;
revoke all on function student_save(text, uuid, jsonb) from public;
revoke all on function create_lesson(text, text) from public;
grant execute on function student_enter(text, text, text, text, boolean) to anon, authenticated;
grant execute on function student_state(text, text) to anon, authenticated;
grant execute on function teacher_students(uuid) to authenticated;
grant execute on function student_sim(text, uuid) to anon, authenticated;
grant execute on function student_save(text, uuid, jsonb) to anon, authenticated;
grant execute on function create_lesson(text, text) to authenticated;
grant execute on function is_teacher() to authenticated;

-- ------------------------------------------------------------
-- 슬라이드 그림 저장소: 누구나 주소로 볼 수 있고(학생 화면), 교사만 올리고 지운다.
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('slides', 'slides', true, 3145728, array['image/jpeg', 'image/png'])
  on conflict (id) do update set public = true, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg', 'image/png'];

drop policy if exists slides_teacher_read on storage.objects;
drop policy if exists slides_teacher_insert on storage.objects;
drop policy if exists slides_teacher_update on storage.objects;
drop policy if exists slides_teacher_delete on storage.objects;
create policy slides_teacher_read on storage.objects for select to authenticated using (bucket_id = 'slides' and is_teacher());
create policy slides_teacher_insert on storage.objects for insert to authenticated with check (bucket_id = 'slides' and is_teacher());
create policy slides_teacher_update on storage.objects for update to authenticated using (bucket_id = 'slides' and is_teacher()) with check (bucket_id = 'slides' and is_teacher());
create policy slides_teacher_delete on storage.objects for delete to authenticated using (bucket_id = 'slides' and is_teacher());

-- ------------------------------------------------------------
-- 교사 이메일: teacher@example.com 을 자기 이메일(소문자)로 바꾸세요. 여러 명이면 줄을 더하면 됩니다.
-- ------------------------------------------------------------
insert into teachers (email) values ('junhyuk584@knue.ac.kr') on conflict do nothing;
