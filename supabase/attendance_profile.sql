-- 2026-07-26: editable student identity + compact teacher attendance/payroll rows.
-- Safe to run repeatedly in Supabase SQL Editor.

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

create or replace function api_update_student_identity(
  teacher_key text,
  student_id uuid,
  new_name text,
  new_dob date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean text := title_name(api_update_student_identity.new_name);
  duplicate_id uuid;
begin
  perform require_teacher(api_update_student_identity.teacher_key);
  if clean = '' or api_update_student_identity.new_dob is null then
    raise exception 'Nhập đủ họ tên và ngày sinh';
  end if;

  if not exists (
    select 1
    from submissions s
    where s.student_id = api_update_student_identity.student_id
      and can_access_class(api_update_student_identity.teacher_key, s.class_id)
  ) then
    raise exception 'Không có quyền sửa học sinh này';
  end if;

  select st.id into duplicate_id
  from students st
  where st.name_key = name_key(clean)
    and st.dob = api_update_student_identity.new_dob
    and st.id <> api_update_student_identity.student_id
  limit 1;
  if duplicate_id is not null then
    raise exception 'Đã có học sinh khác trùng họ tên và ngày sinh';
  end if;

  update students st
  set student_name = clean,
      name_key = name_key(clean),
      dob = api_update_student_identity.new_dob,
      updated_at = now()
  where st.id = api_update_student_identity.student_id;
  if not found then raise exception 'Không tìm thấy học sinh'; end if;

  update submissions s
  set student_name = clean,
      name_key = name_key(clean),
      dob = api_update_student_identity.new_dob,
      updated_at = now()
  where s.student_id = api_update_student_identity.student_id;

  return jsonb_build_object('ok', true, 'name', clean, 'dob', api_update_student_identity.new_dob);
end;
$$;

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

  with lesson_rows as (
    select
      c.id as class_id,
      c.name as class_name,
      h.record_type,
      g.lesson_index,
      h.cells,
      (case when h.record_type = 'LR' then 2 else 6 end) as meta_rows,
      (3 + g.lesson_index * 4) as attendance_col,
      coalesce(nullif(h.cells ->> ('0|' || (3 + g.lesson_index * 4)::text), ''),
               'B' || (g.lesson_index + 1)::text) as lesson_title,
      coalesce(nullif(h.cells ->> ('0|' || (4 + g.lesson_index * 4)::text), ''),
               h.record_type || (g.lesson_index + 1)::text) as lesson_label,
      coalesce(h.cells ->> ('0|' || (5 + g.lesson_index * 4)::text), '') as record_date,
      coalesce(h.cells ->> ('0|' || (6 + g.lesson_index * 4)::text), '') as record_teacher
    from homeroom_records h
    join classes c on c.id = h.class_id and not c.archived
    cross join lateral generate_series(0, greatest(0, h.lesson_count - 1)) as g(lesson_index)
    where can_access_class(api_attendance_rows.teacher_key, c.id)
  ),
  expanded as (
    select
      lr.*,
      coalesce(counts.student_count, 0) as student_count,
      coalesce(counts.present_count, 0) as present_count,
      coalesce(counts.absent_count, 0) as absent_count,
      coalesce(ae.data, '{}'::jsonb) as entry,
      ae.updated_at,
      coalesce(ta.display_name, '') as updated_by
    from lesson_rows lr
    left join lateral (
      select
        count(*)::integer as student_count,
        count(*) filter (where roster.mark in ('TRUE', 'P', 'X', 'CÓ', 'CÓ MẶT', '1'))::integer as present_count,
        count(*) filter (where roster.mark in ('FALSE', 'V', 'VẮNG', 'A', '0'))::integer as absent_count
      from (
        select upper(trim(coalesce(
          lr.cells ->> (
            (lr.meta_rows + row_number() over (order by lower(s.student_name), s.student_name, s.dob) - 1)::text
            || '|' || lr.attendance_col::text
          ), ''
        ))) as mark
        from submissions s
        where s.class_id = lr.class_id and s.status = 'approved'
      ) roster
    ) counts on true
    left join attendance_entries ae
      on ae.class_id = lr.class_id
      and ae.record_type = lr.record_type
      and ae.lesson_index = lr.lesson_index
    left join teacher_accounts ta on ta.id = ae.updated_by
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'classId', e.class_id,
      'className', e.class_name,
      'recordType', e.record_type,
      'lessonIndex', e.lesson_index,
      'lessonTitle', e.lesson_title,
      'lessonLabel', e.lesson_label,
      'recordDate', e.record_date,
      'recordTeacher', e.record_teacher,
      'studentCount', e.student_count,
      'presentCount', e.present_count,
      'absentCount', e.absent_count,
      'entry', e.entry,
      'updatedAt', e.updated_at,
      'updatedBy', e.updated_by
    )
    order by lower(e.class_name), e.class_name,
      case e.record_type when 'LR' then 1 when 'S' then 2 else 3 end,
      e.lesson_index
  ), '[]'::jsonb)
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
begin
  perform require_class_manager(api_save_attendance_entry.teacher_key, api_save_attendance_entry.class_id);
  if api_save_attendance_entry.record_type not in ('LR', 'S', 'W')
     or api_save_attendance_entry.lesson_index not between 0 and 299 then
    raise exception 'Buổi học không hợp lệ';
  end if;
  if clean_status not in ('', 'Chưa chốt', 'Đã dạy', 'Dạy bù', 'Nghỉ') then
    clean_status := 'Chưa chốt';
  end if;

  clean_entry := jsonb_build_object(
    'lessonDate', left(clean_name(api_save_attendance_entry.entry ->> 'lessonDate'), 10),
    'teacherName', left(clean_name(api_save_attendance_entry.entry ->> 'teacherName'), 120),
    'startTime', left(clean_name(api_save_attendance_entry.entry ->> 'startTime'), 5),
    'endTime', left(clean_name(api_save_attendance_entry.entry ->> 'endTime'), 5),
    'periods', left(clean_name(api_save_attendance_entry.entry ->> 'periods'), 8),
    'status', coalesce(nullif(clean_status, ''), 'Chưa chốt'),
    'note', left(clean_name(api_save_attendance_entry.entry ->> 'note'), 1000)
  );

  insert into attendance_entries as ae
    (class_id, record_type, lesson_index, data, updated_by, updated_at)
  values (
    api_save_attendance_entry.class_id,
    api_save_attendance_entry.record_type,
    api_save_attendance_entry.lesson_index,
    clean_entry,
    session_teacher_id(api_save_attendance_entry.teacher_key),
    now()
  )
  on conflict on constraint attendance_entries_pkey do update
    set data = excluded.data,
        updated_by = excluded.updated_by,
        updated_at = now();

  return jsonb_build_object('ok', true, 'entry', clean_entry);
end;
$$;

grant execute on function api_update_student_identity(text, uuid, text, date) to anon;
grant execute on function api_attendance_rows(text) to anon;
grant execute on function api_save_attendance_entry(text, text, text, integer, jsonb) to anon;

