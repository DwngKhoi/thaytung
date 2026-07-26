-- 2026-07-26: owner-managed vocabulary + Schedule -> Homeroom -> Attendance sync.
-- Safe to run repeatedly after schema.sql or attendance_profile.sql.

-- ---------------------------------------------------------------------------
-- Teacher dropdown: expose display names only, never usernames/passwords.
-- ---------------------------------------------------------------------------
create or replace function api_teacher_directory(teacher_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform require_teacher(api_teacher_directory.teacher_key);
  return jsonb_build_array(jsonb_build_object('name', 'Thầy Tùng', 'role', 'owner'))
    || coalesce((
      select jsonb_agg(jsonb_build_object('name', a.display_name, 'role', 'teacher')
                       order by lower(a.display_name), a.display_name, a.id)
      from teacher_accounts a
      where a.active
    ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Vocabulary overrides. The 520 bundled words remain static; this table only
-- stores owner additions and compact tombstones for bundled words being hidden.
-- ---------------------------------------------------------------------------
create table if not exists vocabulary_customizations (
  id uuid primary key default gen_random_uuid(),
  book_id text not null,
  unit_no integer not null check (unit_no between 1 and 100),
  action text not null check (action in ('add', 'remove')),
  word_key text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists vocabulary_remove_unique
  on vocabulary_customizations (book_id, unit_no, word_key)
  where action = 'remove';

alter table vocabulary_customizations enable row level security;
drop policy if exists "deny direct vocabulary_customizations" on vocabulary_customizations;
create policy "deny direct vocabulary_customizations"
  on vocabulary_customizations for all using (false) with check (false);

create or replace function api_vocabulary_customizations(teacher_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform require_teacher(api_vocabulary_customizations.teacher_key);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', v.id,
      'bookId', v.book_id,
      'unitNo', v.unit_no,
      'action', v.action,
      'wordKey', v.word_key,
      'data', v.data
    ) order by v.created_at, v.id)
    from vocabulary_customizations v
  ), '[]'::jsonb);
end;
$$;

create or replace function api_add_vocabulary_word(
  teacher_key text,
  book_id text,
  unit_no integer,
  word jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_word text := left(clean_name(api_add_vocabulary_word.word ->> 'w'), 120);
  clean_key text;
  clean_data jsonb;
  new_id uuid;
begin
  perform require_owner(api_add_vocabulary_word.teacher_key);
  if clean_word = '' or clean_name(api_add_vocabulary_word.word ->> 'vn') = '' then
    raise exception 'Cần nhập từ và nghĩa tiếng Việt';
  end if;
  if clean_name(api_add_vocabulary_word.book_id) = ''
     or api_add_vocabulary_word.unit_no not between 1 and 100 then
    raise exception 'Giáo trình hoặc Unit không hợp lệ';
  end if;

  clean_key := lower(clean_word);
  clean_data := jsonb_build_object(
    'w', clean_word,
    't', left(clean_name(api_add_vocabulary_word.word ->> 't'), 30),
    'ipa', left(clean_name(api_add_vocabulary_word.word ->> 'ipa'), 120),
    'vn', left(clean_name(api_add_vocabulary_word.word ->> 'vn'), 300),
    'ex', left(clean_name(api_add_vocabulary_word.word ->> 'ex'), 500)
  );

  delete from vocabulary_customizations v
  where v.book_id = api_add_vocabulary_word.book_id
    and v.unit_no = api_add_vocabulary_word.unit_no
    and v.word_key = clean_key
    and v.action = 'remove';

  insert into vocabulary_customizations (book_id, unit_no, action, word_key, data)
  values (left(clean_name(api_add_vocabulary_word.book_id), 60),
          api_add_vocabulary_word.unit_no, 'add', clean_key, clean_data)
  returning id into new_id;
  return jsonb_build_object('ok', true, 'id', new_id, 'data', clean_data);
end;
$$;

create or replace function api_remove_vocabulary_word(
  teacher_key text,
  book_id text,
  unit_no integer,
  word_key text,
  custom_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_key text := lower(left(clean_name(api_remove_vocabulary_word.word_key), 120));
begin
  perform require_owner(api_remove_vocabulary_word.teacher_key);
  if api_remove_vocabulary_word.custom_id is not null then
    delete from vocabulary_customizations v
    where v.id = api_remove_vocabulary_word.custom_id and v.action = 'add';
  else
    insert into vocabulary_customizations (book_id, unit_no, action, word_key, data)
    values (left(clean_name(api_remove_vocabulary_word.book_id), 60),
            api_remove_vocabulary_word.unit_no, 'remove', clean_key, '{}'::jsonb)
    on conflict (book_id, unit_no, word_key) where action = 'remove' do nothing;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Extended schedule metadata. It is saved separately so this migration works
-- even when the older api_save_schedule_week RPC is still installed.
-- ---------------------------------------------------------------------------
create or replace function api_save_schedule_extra_details(
  teacher_key text,
  class_id text,
  week_start date,
  details jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_details jsonb;
begin
  perform require_class_manager(api_save_schedule_extra_details.teacher_key,
                                api_save_schedule_extra_details.class_id);
  select coalesce(jsonb_object_agg(d.key, jsonb_build_object(
    'location', left(clean_name(d.value ->> 'location'), 80),
    'note', left(clean_name(d.value ->> 'note'), 300),
    'startTime', case
      when clean_name(d.value ->> 'startTime') ~ '^[0-2][0-9]:[0-5][0-9]$'
      then clean_name(d.value ->> 'startTime') else '' end,
    'teacherName', left(clean_name(d.value ->> 'teacherName'), 120)
  )), '{}'::jsonb)
  into clean_details
  from jsonb_each(coalesce(api_save_schedule_extra_details.details, '{}'::jsonb)) d
  where d.key ~ '^[0-6]-[0-9]+$';

  update class_schedule_weeks w
  set details = clean_details,
      updated_at = now()
  where w.class_id = api_save_schedule_extra_details.class_id
    and w.week_start = api_save_schedule_extra_details.week_start;
  if not found then raise exception 'Không tìm thấy tuần vừa lưu'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function api_homeroom_schedule_sync(
  teacher_key text,
  class_id text,
  record_type text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  perform require_class_manager(api_homeroom_schedule_sync.teacher_key,
                                api_homeroom_schedule_sync.class_id);
  if api_homeroom_schedule_sync.record_type not in ('LR', 'S', 'W') then
    raise exception 'Loại sổ không hợp lệ';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'lessonLabel', q.lesson_label,
    'lessonDate', q.lesson_date::text,
    'dayName', q.day_name,
    'sessionName', q.session_name,
    'startTime', q.start_time,
    'teacherName', q.teacher_name,
    'location', q.location,
    'note', q.note
  ) order by q.lesson_date, q.session_index, q.lesson_label), '[]'::jsonb)
  into result
  from (
    select
      slot.value as lesson_label,
      w.week_start + split_part(slot.key, '-', 1)::integer as lesson_date,
      (array['Thứ 2','Thứ 3','Thứ 4','Thứ 5','Thứ 6','Thứ 7','Chủ nhật'])
        [split_part(slot.key, '-', 1)::integer + 1] as day_name,
      split_part(slot.key, '-', 2)::integer as session_index,
      coalesce(c.sessions[split_part(slot.key, '-', 2)::integer + 1], '') as session_name,
      coalesce(w.details -> slot.key ->> 'startTime', '') as start_time,
      coalesce(w.details -> slot.key ->> 'teacherName', '') as teacher_name,
      coalesce(w.details -> slot.key ->> 'location', '') as location,
      coalesce(w.details -> slot.key ->> 'note', '') as note
    from class_schedule_weeks w
    join classes c on c.id = w.class_id
    cross join lateral jsonb_each_text(w.slots) slot
    where w.class_id = api_homeroom_schedule_sync.class_id
      and slot.value ~ ('^' || api_homeroom_schedule_sync.record_type || '[0-9]+$')
  ) q;
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Attendance source: union saved homeroom lessons with lessons found in the
-- weekly schedule. Metadata prefers an explicit homeroom edit, then schedule.
-- ---------------------------------------------------------------------------
create table if not exists attendance_entries (
  class_id text not null references classes(id) on delete cascade,
  record_type text not null check (record_type in ('LR', 'S', 'W')),
  lesson_index integer not null check (lesson_index between 0 and 299),
  data jsonb not null default '{}'::jsonb,
  updated_by uuid references teacher_accounts(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (class_id, record_type, lesson_index)
);
alter table attendance_entries enable row level security;
drop policy if exists "deny direct attendance_entries" on attendance_entries;
create policy "deny direct attendance_entries"
  on attendance_entries for all using (false) with check (false);

create or replace function api_attendance_rows(teacher_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  perform require_teacher(api_attendance_rows.teacher_key);

  with raw_schedule as (
    select
      c.id as class_id,
      c.name as class_name,
      case
        when slot.value ~ '^LR[0-9]+$' then 'LR'
        when slot.value ~ '^S[0-9]+$' then 'S'
        when slot.value ~ '^W[0-9]+$' then 'W'
      end as record_type,
      slot.value as lesson_label,
      w.week_start + split_part(slot.key, '-', 1)::integer as lesson_date,
      split_part(slot.key, '-', 2)::integer as session_index,
      coalesce(w.details -> slot.key ->> 'startTime', '') as start_time,
      coalesce(w.details -> slot.key ->> 'teacherName', '') as teacher_name
    from class_schedule_weeks w
    join classes c on c.id = w.class_id and not c.archived
    cross join lateral jsonb_each_text(w.slots) slot
    where slot.value ~ '^(LR|S|W)[0-9]+$'
      and can_access_class(api_attendance_rows.teacher_key, c.id)
  ),
  schedule_lessons as (
    select rs.*,
      (row_number() over (
        partition by rs.class_id, rs.record_type
        order by rs.lesson_date, rs.session_index, rs.lesson_label
      ) - 1)::integer as lesson_index
    from raw_schedule rs
  ),
  lesson_keys as (
    select h.class_id, h.record_type, g.lesson_index
    from homeroom_records h
    cross join lateral generate_series(0, greatest(0, h.lesson_count - 1)) g(lesson_index)
    where can_access_class(api_attendance_rows.teacher_key, h.class_id)
    union
    select sl.class_id, sl.record_type, sl.lesson_index from schedule_lessons sl
  ),
  expanded as (
    select
      lk.class_id,
      c.name as class_name,
      lk.record_type,
      lk.lesson_index,
      coalesce(nullif(h.cells ->> ('0|' || (3 + lk.lesson_index * 4)::text), ''),
               'B' || (lk.lesson_index + 1)::text) as lesson_title,
      coalesce(nullif(h.cells ->> ('0|' || (4 + lk.lesson_index * 4)::text), ''),
               sl.lesson_label,
               lk.record_type || (lk.lesson_index + 1)::text) as lesson_label,
      coalesce(sl.lesson_date::text,
               nullif(h.cells ->> ('0|' || (5 + lk.lesson_index * 4)::text), ''),
               '') as record_date,
      coalesce(nullif(h.cells ->> ('0|' || (6 + lk.lesson_index * 4)::text), ''),
               sl.teacher_name, '') as record_teacher,
      coalesce(sl.start_time, '') as record_start_time,
      coalesce(counts.student_count, 0) as student_count,
      coalesce(counts.present_count, 0) as present_count,
      coalesce(counts.absent_count, 0) as absent_count,
      coalesce(ae.data, '{}'::jsonb) as entry,
      ae.updated_at,
      coalesce(ta.display_name, '') as updated_by
    from lesson_keys lk
    join classes c on c.id = lk.class_id and not c.archived
    left join homeroom_records h
      on h.class_id = lk.class_id and h.record_type = lk.record_type
    left join schedule_lessons sl
      on sl.class_id = lk.class_id and sl.record_type = lk.record_type
      and sl.lesson_index = lk.lesson_index
    left join lateral (
      select
        count(*)::integer as student_count,
        count(*) filter (where roster.mark in ('TRUE','P','X','CÓ','CÓ MẶT','1'))::integer as present_count,
        count(*) filter (where roster.mark in ('FALSE','V','VẮNG','A','0'))::integer as absent_count
      from (
        select upper(trim(coalesce(
          h.cells ->> (
            ((case when lk.record_type = 'LR' then 2 else 6 end)
             + row_number() over (order by lower(s.student_name), s.student_name, s.dob) - 1)::text
            || '|' || (3 + lk.lesson_index * 4)::text
          ), ''
        ))) as mark
        from submissions s
        where s.class_id = lk.class_id and s.status = 'approved'
      ) roster
    ) counts on true
    left join attendance_entries ae
      on ae.class_id = lk.class_id and ae.record_type = lk.record_type
      and ae.lesson_index = lk.lesson_index
    left join teacher_accounts ta on ta.id = ae.updated_by
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'classId', e.class_id, 'className', e.class_name,
    'recordType', e.record_type, 'lessonIndex', e.lesson_index,
    'lessonTitle', e.lesson_title, 'lessonLabel', e.lesson_label,
    'recordDate', e.record_date, 'recordTeacher', e.record_teacher,
    'recordStartTime', e.record_start_time,
    'studentCount', e.student_count, 'presentCount', e.present_count,
    'absentCount', e.absent_count, 'entry', e.entry,
    'updatedAt', e.updated_at, 'updatedBy', e.updated_by
  ) order by lower(e.class_name), e.class_name,
    case e.record_type when 'LR' then 1 when 'S' then 2 else 3 end,
    e.lesson_index), '[]'::jsonb)
  into result
  from expanded e;
  return result;
end;
$$;

create or replace function api_save_attendance_entry(
  teacher_key text,
  class_id text,
  record_type text,
  lesson_index integer,
  entry jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_entry jsonb;
  clean_status text := left(clean_name(api_save_attendance_entry.entry ->> 'status'), 30);
  date_text text := left(clean_name(api_save_attendance_entry.entry ->> 'lessonDate'), 10);
  teacher_text text := left(clean_name(api_save_attendance_entry.entry ->> 'teacherName'), 120);
begin
  perform require_class_manager(api_save_attendance_entry.teacher_key,
                                api_save_attendance_entry.class_id);
  if api_save_attendance_entry.record_type not in ('LR','S','W')
     or api_save_attendance_entry.lesson_index not between 0 and 299 then
    raise exception 'Buổi học không hợp lệ';
  end if;
  if clean_status not in ('', 'Chưa chốt', 'Đã dạy', 'Dạy bù', 'Nghỉ') then
    clean_status := 'Chưa chốt';
  end if;

  clean_entry := jsonb_build_object(
    'lessonDate', date_text,
    'teacherName', teacher_text,
    'startTime', left(clean_name(api_save_attendance_entry.entry ->> 'startTime'), 5),
    'endTime', left(clean_name(api_save_attendance_entry.entry ->> 'endTime'), 5),
    'periods', left(clean_name(api_save_attendance_entry.entry ->> 'periods'), 8),
    'status', coalesce(nullif(clean_status, ''), 'Chưa chốt'),
    'note', left(clean_name(api_save_attendance_entry.entry ->> 'note'), 1000)
  );

  insert into attendance_entries as ae
    (class_id, record_type, lesson_index, data, updated_by, updated_at)
  values (api_save_attendance_entry.class_id, api_save_attendance_entry.record_type,
          api_save_attendance_entry.lesson_index, clean_entry,
          session_teacher_id(api_save_attendance_entry.teacher_key), now())
  on conflict on constraint attendance_entries_pkey do update
    set data = excluded.data, updated_by = excluded.updated_by, updated_at = now();

  return jsonb_build_object('ok', true, 'entry', clean_entry);
end;
$$;

grant execute on function api_teacher_directory(text) to anon;
grant execute on function api_vocabulary_customizations(text) to anon;
grant execute on function api_add_vocabulary_word(text, text, integer, jsonb) to anon;
grant execute on function api_remove_vocabulary_word(text, text, integer, text, uuid) to anon;
grant execute on function api_save_schedule_extra_details(text, text, date, jsonb) to anon;
grant execute on function api_homeroom_schedule_sync(text, text, text) to anon;
grant execute on function api_attendance_rows(text) to anon;
grant execute on function api_save_attendance_entry(text, text, text, integer, jsonb) to anon;
