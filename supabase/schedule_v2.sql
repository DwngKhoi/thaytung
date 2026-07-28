-- Olympus schedule v2
-- Run this file once in Supabase SQL Editor after schema.sql / vocab_schedule_sync.sql.

alter table classes
  add column if not exists course_kind text not null default 'skills';
alter table classes
  add column if not exists current_schedule_week date;

update classes
set course_kind = 'grammar'
where course_kind = 'skills'
  and (
    name ~* '^G[0-9]+'
    or sector_id in (
      select cs.id from class_sectors cs
      where lower(cs.name) like '%ngữ pháp%'
    )
  );

update classes
set lesson_starts =
  '{"S":1,"W":1,"LR":1,"L":1,"R":1,"COURSE":1}'::jsonb
  || coalesce(lesson_starts, '{}'::jsonb);

create or replace function class_summary(c classes)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'sessions', c.sessions,
    'currentSlots', c.current_slots,
    'finalSubjects', c.final_subjects,
    'finalDetails', coalesce((
      select w.details
      from class_schedule_weeks w
      where w.class_id = c.id
      order by
        case when w.week_start = c.current_schedule_week then 0 else 1 end,
        w.week_start desc
      limit 1
    ), '{}'::jsonb),
    'courseKind', c.course_kind,
    'lessonStarts', c.lesson_starts,
    'sectorId', c.sector_id,
    'sectorName', (select cs.name from class_sectors cs where cs.id = c.sector_id),
    'approvedCount', (
      select count(*) from submissions s
      where s.class_id = c.id and s.status = 'approved'
    ),
    'pendingCount', (
      select count(*) from submissions s
      where s.class_id = c.id and s.status = 'pending'
    )
  );
$$;

create or replace function api_class(teacher_key text, class_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  target classes;
begin
  perform require_teacher(api_class.teacher_key);
  if not can_access_class(api_class.teacher_key, api_class.class_id) then
    raise exception 'Không có quyền xem lớp này';
  end if;
  select c.* into target
  from classes c
  where c.id = api_class.class_id;
  if not found then raise exception 'Không tìm thấy lớp'; end if;

  return class_summary(target) || jsonb_build_object(
    'archived', target.archived,
    'submissions', coalesce((
      select jsonb_agg(
        teacher_submission_json(s)
        order by lower(coalesce(st.student_name, s.student_name)),
                 coalesce(st.student_name, s.student_name),
                 coalesce(st.dob, s.dob)
      )
      from submissions s
      left join students st on st.id = s.student_id
      where s.class_id = target.id
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function api_schedule_class(
  teacher_key text,
  class_id text,
  selected_week_start date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  target classes;
  monday date := current_date - (extract(isodow from current_date)::integer - 1);
  requested date := coalesce(api_schedule_class.selected_week_start, monday);
  selected_week jsonb;
  before_max jsonb;
  all_max jsonb;
  pending_before jsonb;
begin
  perform require_class_manager(api_schedule_class.teacher_key, api_schedule_class.class_id);
  select c.* into target
  from classes c
  where c.id = api_schedule_class.class_id and not c.archived;
  if not found then raise exception 'Không tìm thấy lớp'; end if;

  select jsonb_build_object(
    'weekStart', w.week_start::text,
    'title', w.title,
    'slots', w.slots,
    'activeSlots', w.active_slots,
    'details', w.details
  )
  into selected_week
  from class_schedule_weeks w
  where w.class_id = target.id and w.week_start = requested;

  select jsonb_build_object(
    'S', coalesce(max(substring(e.value from '^S([0-9]+)$')::integer)
                  filter (where e.value ~ '^S[0-9]+$'), 0),
    'W', coalesce(max(substring(e.value from '^W([0-9]+)$')::integer)
                  filter (where e.value ~ '^W[0-9]+$'), 0),
    'LR', coalesce(max(substring(e.value from '^LR([0-9]+)$')::integer)
                   filter (where e.value ~ '^LR[0-9]+$'), 0),
    'L', coalesce(max(substring(e.value from '^L([0-9]+)$')::integer)
                  filter (where e.value ~ '^L[0-9]+$'), 0),
    'R', coalesce(max(substring(e.value from '^R([0-9]+)$')::integer)
                  filter (where e.value ~ '^R[0-9]+$'), 0),
    'COURSE', coalesce(max(
      substring(d.value ->> 'courseNo' from '^([0-9]+)')::integer
    ) filter (where coalesce(d.value ->> 'courseNo', '') ~ '^[0-9]+[ab]?$'), 0)
  )
  into before_max
  from class_schedule_weeks w
  left join lateral jsonb_each_text(w.slots) e on true
  left join lateral jsonb_each(w.details) d on d.key = e.key
  where w.class_id = target.id and w.week_start < requested;

  select jsonb_build_object(
    'S', coalesce(max(substring(e.value from '^S([0-9]+)$')::integer)
                  filter (where e.value ~ '^S[0-9]+$'), 0),
    'W', coalesce(max(substring(e.value from '^W([0-9]+)$')::integer)
                  filter (where e.value ~ '^W[0-9]+$'), 0),
    'LR', coalesce(max(substring(e.value from '^LR([0-9]+)$')::integer)
                   filter (where e.value ~ '^LR[0-9]+$'), 0),
    'L', coalesce(max(substring(e.value from '^L([0-9]+)$')::integer)
                  filter (where e.value ~ '^L[0-9]+$'), 0),
    'R', coalesce(max(substring(e.value from '^R([0-9]+)$')::integer)
                  filter (where e.value ~ '^R[0-9]+$'), 0),
    'COURSE', coalesce(max(
      substring(d.value ->> 'courseNo' from '^([0-9]+)')::integer
    ) filter (where coalesce(d.value ->> 'courseNo', '') ~ '^[0-9]+[ab]?$'), 0)
  )
  into all_max
  from class_schedule_weeks w
  left join lateral jsonb_each_text(w.slots) e on true
  left join lateral jsonb_each(w.details) d on d.key = e.key
  where w.class_id = target.id;

  select case
    when last_slot.lesson_label ~ '^(MT1|FT1)$'
      and last_slot.course_no ~ '^[0-9]+a$'
    then jsonb_build_object(
      'type', substring(last_slot.lesson_label from '^(MT|FT)'),
      'course', substring(last_slot.course_no from '^([0-9]+)')::integer
    )
    else null
  end
  into pending_before
  from (
    select
      e.value as lesson_label,
      coalesce(d.value ->> 'courseNo', '') as course_no
    from class_schedule_weeks w
    cross join lateral jsonb_each_text(w.slots) e
    left join lateral jsonb_each(w.details) d on d.key = e.key
    where w.class_id = target.id and w.week_start < requested
    order by
      w.week_start desc,
      split_part(e.key, '-', 1)::integer desc,
      split_part(e.key, '-', 2)::integer desc
    limit 1
  ) last_slot;

  return jsonb_build_object(
    'id', target.id,
    'name', target.name,
    'sessions', target.sessions,
    'currentSlots', target.current_slots,
    'finalSubjects', target.final_subjects,
    'finalDetails', coalesce((
      select w.details from class_schedule_weeks w
      where w.class_id = target.id
      order by
        case when w.week_start = target.current_schedule_week then 0 else 1 end,
        w.week_start desc
      limit 1
    ), '{}'::jsonb),
    'courseKind', target.course_kind,
    'lessonStarts', target.lesson_starts,
    'sectorId', target.sector_id,
    'sectorName', (select cs.name from class_sectors cs where cs.id = target.sector_id),
    'currentWeekStart', monday::text,
    'selectedWeekStart', requested::text,
    'selectedWeek', selected_week,
    'weeks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'weekStart', w.week_start::text,
        'title', w.title
      ) order by w.week_start desc)
      from class_schedule_weeks w
      where w.class_id = target.id
    ), '[]'::jsonb),
    'sequenceBefore', coalesce(before_max, '{}'::jsonb),
    'pendingAssessmentBefore', pending_before,
    'lessonMaximums', coalesce(all_max, '{}'::jsonb)
  );
end;
$$;

create or replace function api_save_schedule_settings(
  teacher_key text,
  class_id text,
  course_kind text,
  lesson_starts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_kind text;
  clean_starts jsonb;
begin
  perform require_class_manager(
    api_save_schedule_settings.teacher_key,
    api_save_schedule_settings.class_id
  );
  clean_kind := case
    when lower(clean_name(api_save_schedule_settings.course_kind)) = 'grammar'
    then 'grammar' else 'skills' end;
  clean_starts := jsonb_build_object(
    'S', greatest(coalesce(case when lesson_starts ->> 'S' ~ '^[0-9]+$' then (lesson_starts ->> 'S')::integer end, 1), 1),
    'W', greatest(coalesce(case when lesson_starts ->> 'W' ~ '^[0-9]+$' then (lesson_starts ->> 'W')::integer end, 1), 1),
    'LR', greatest(coalesce(case when lesson_starts ->> 'LR' ~ '^[0-9]+$' then (lesson_starts ->> 'LR')::integer end, 1), 1),
    'L', greatest(coalesce(case when lesson_starts ->> 'L' ~ '^[0-9]+$' then (lesson_starts ->> 'L')::integer end, 1), 1),
    'R', greatest(coalesce(case when lesson_starts ->> 'R' ~ '^[0-9]+$' then (lesson_starts ->> 'R')::integer end, 1), 1),
    'COURSE', greatest(coalesce(case when lesson_starts ->> 'COURSE' ~ '^[0-9]+$' then (lesson_starts ->> 'COURSE')::integer end, 1), 1)
  );
  update classes c
  set course_kind = clean_kind, lesson_starts = clean_starts
  where c.id = api_save_schedule_settings.class_id;
  if not found then raise exception 'Không tìm thấy lớp'; end if;
  return jsonb_build_object('ok', true, 'courseKind', clean_kind, 'lessonStarts', clean_starts);
end;
$$;

create or replace function api_save_schedule_week(
  teacher_key text,
  class_id text,
  week_start date,
  title text,
  week_slots jsonb,
  week_details jsonb,
  current_slots text[],
  sessions text[],
  lesson_starts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target classes;
  clean_sessions text[];
  clean_current text[];
  clean_slots jsonb;
  clean_details jsonb;
  clean_starts jsonb;
begin
  perform require_class_manager(api_save_schedule_week.teacher_key, api_save_schedule_week.class_id);
  select c.* into target
  from classes c
  where c.id = api_save_schedule_week.class_id and not c.archived;
  if not found then raise exception 'Không tìm thấy lớp'; end if;
  if api_save_schedule_week.week_start is null then
    raise exception 'Thiếu ngày bắt đầu tuần';
  end if;

  select coalesce(array_agg(x.value order by x.ord), '{}')
  into clean_sessions
  from (
    select min(t.ord) as ord, clean_name(t.value) as value
    from unnest(coalesce(api_save_schedule_week.sessions, '{}'))
      with ordinality t(value, ord)
    where clean_name(t.value) <> ''
    group by lower(clean_name(t.value)), clean_name(t.value)
    order by min(t.ord)
    limit 12
  ) x;
  if coalesce(array_length(clean_sessions, 1), 0) = 0 then
    raise exception 'Cần ít nhất một ca';
  end if;

  select coalesce(array_agg(v.slot order by v.day_index, v.session_index), '{}')
  into clean_current
  from (
    select distinct
      clean_name(u.value) as slot,
      split_part(clean_name(u.value), '-', 1)::integer as day_index,
      split_part(clean_name(u.value), '-', 2)::integer as session_index
    from unnest(coalesce(api_save_schedule_week.current_slots, '{}')) u(value)
    where clean_name(u.value) ~ '^[0-6]-[0-9]+$'
      and split_part(clean_name(u.value), '-', 2)::integer < array_length(clean_sessions, 1)
  ) v;

  select coalesce(jsonb_object_agg(e.key, upper(clean_name(e.value))), '{}'::jsonb)
  into clean_slots
  from jsonb_each_text(coalesce(api_save_schedule_week.week_slots, '{}'::jsonb)) e
  where e.key = any(clean_current)
    and upper(clean_name(e.value)) ~
      '^(S[0-9]+|W[0-9]+|LR[0-9]+|L[0-9]+|R[0-9]+|MT[12]?|FT[12]?|OFF|LESSON|REVIEW)$';

  select coalesce(jsonb_object_agg(d.key, jsonb_build_object(
    'location', left(clean_name(d.value ->> 'location'), 80),
    'note', left(clean_name(d.value ->> 'note'), 300),
    'startTime', case
      when clean_name(d.value ->> 'startTime') ~ '^[0-2][0-9]:[0-5][0-9]$'
      then clean_name(d.value ->> 'startTime') else '' end,
    'teacherName', left(clean_name(d.value ->> 'teacherName'), 120),
    'courseNo', case
      when clean_name(d.value ->> 'courseNo') ~ '^[0-9]+[ab]?$'
      then clean_name(d.value ->> 'courseNo') else '' end,
    'lessonType', case
      when upper(clean_name(d.value ->> 'lessonType')) ~ '^(LR|L|R|W|S|MT|FT|OFF|LESSON)$'
      then upper(clean_name(d.value ->> 'lessonType')) else '' end
  )), '{}'::jsonb)
  into clean_details
  from jsonb_each(coalesce(api_save_schedule_week.week_details, '{}'::jsonb)) d
  where d.key = any(clean_current);

  clean_starts := jsonb_build_object(
    'S', greatest(coalesce(case when lesson_starts ->> 'S' ~ '^[0-9]+$' then (lesson_starts ->> 'S')::integer end, 1), 1),
    'W', greatest(coalesce(case when lesson_starts ->> 'W' ~ '^[0-9]+$' then (lesson_starts ->> 'W')::integer end, 1), 1),
    'LR', greatest(coalesce(case when lesson_starts ->> 'LR' ~ '^[0-9]+$' then (lesson_starts ->> 'LR')::integer end, 1), 1),
    'L', greatest(coalesce(case when lesson_starts ->> 'L' ~ '^[0-9]+$' then (lesson_starts ->> 'L')::integer end, 1), 1),
    'R', greatest(coalesce(case when lesson_starts ->> 'R' ~ '^[0-9]+$' then (lesson_starts ->> 'R')::integer end, 1), 1),
    'COURSE', greatest(coalesce(case when lesson_starts ->> 'COURSE' ~ '^[0-9]+$' then (lesson_starts ->> 'COURSE')::integer end, 1), 1)
  );

  update classes c
  set sessions = clean_sessions,
      current_slots = clean_current,
      final_subjects = clean_slots,
      lesson_starts = clean_starts,
      current_schedule_week = api_save_schedule_week.week_start
  where c.id = target.id;

  insert into class_schedule_weeks (
    class_id, week_start, title, slots, active_slots, details, updated_at
  )
  values (
    target.id,
    api_save_schedule_week.week_start,
    coalesce(nullif(clean_name(api_save_schedule_week.title), ''), 'Tuần'),
    clean_slots,
    clean_current,
    clean_details,
    now()
  )
  on conflict on constraint class_schedule_weeks_class_id_week_start_key do update
  set title = excluded.title,
      slots = excluded.slots,
      active_slots = excluded.active_slots,
      details = excluded.details,
      updated_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

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
  perform require_class_manager(
    api_save_schedule_extra_details.teacher_key,
    api_save_schedule_extra_details.class_id
  );
  select coalesce(jsonb_object_agg(d.key, jsonb_build_object(
    'location', left(clean_name(d.value ->> 'location'), 80),
    'note', left(clean_name(d.value ->> 'note'), 300),
    'startTime', case
      when clean_name(d.value ->> 'startTime') ~ '^[0-2][0-9]:[0-5][0-9]$'
      then clean_name(d.value ->> 'startTime') else '' end,
    'teacherName', left(clean_name(d.value ->> 'teacherName'), 120),
    'courseNo', case
      when clean_name(d.value ->> 'courseNo') ~ '^[0-9]+[ab]?$'
      then clean_name(d.value ->> 'courseNo') else '' end,
    'lessonType', case
      when upper(clean_name(d.value ->> 'lessonType')) ~ '^(LR|L|R|W|S|MT|FT|OFF|LESSON)$'
      then upper(clean_name(d.value ->> 'lessonType')) else '' end
  )), '{}'::jsonb)
  into clean_details
  from jsonb_each(coalesce(api_save_schedule_extra_details.details, '{}'::jsonb)) d
  where d.key ~ '^[0-6]-[0-9]+$';

  update class_schedule_weeks w
  set details = clean_details, updated_at = now()
  where w.class_id = api_save_schedule_extra_details.class_id
    and w.week_start = api_save_schedule_extra_details.week_start;
  if not found then raise exception 'Không tìm thấy tuần vừa lưu'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function api_schedule_overview(
  teacher_key text,
  week_start date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  current_monday date := current_date - (extract(isodow from current_date)::integer - 1);
  requested date := coalesce(
    api_schedule_overview.week_start,
    current_date - (extract(isodow from current_date)::integer - 1)
  );
  result jsonb;
begin
  perform require_teacher(api_schedule_overview.teacher_key);
  with accessible as (
    select c.*
    from classes c
    where not c.archived
      and can_access_class(api_schedule_overview.teacher_key, c.id)
  ),
  week_directory as (
    select w.week_start, max(w.title) as title
    from class_schedule_weeks w
    join accessible c on c.id = w.class_id
    group by w.week_start
  )
  select jsonb_build_object(
    'weekStart', requested::text,
    'weeks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'weekStart', wd.week_start::text,
        'title', wd.title
      ) order by wd.week_start desc)
      from week_directory wd
    ), '[]'::jsonb),
    'classes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'sessions', c.sessions,
        'courseKind', c.course_kind,
        'lessonStarts', c.lesson_starts,
        'sectorId', c.sector_id,
        'sectorName', (select cs.name from class_sectors cs where cs.id = c.sector_id),
        'activeSlots', coalesce(
          w.active_slots,
          case when requested = current_monday then c.current_slots else '{}'::text[] end
        ),
        'slots', coalesce(
          w.slots,
          case when requested = current_monday then c.final_subjects else '{}'::jsonb end
        ),
        'details', coalesce(
          w.details,
          case when requested = current_monday then coalesce((
            select cw.details from class_schedule_weeks cw
            where cw.class_id = c.id
            order by
              case when cw.week_start = c.current_schedule_week then 0 else 1 end,
              cw.week_start desc
            limit 1
          ), '{}'::jsonb) else '{}'::jsonb end
        )
      ) order by lower(coalesce((select cs.name from class_sectors cs where cs.id = c.sector_id), '')),
                 lower(c.name), c.name, c.id)
      from accessible c
      left join class_schedule_weeks w
        on w.class_id = c.id and w.week_start = requested
    ), '[]'::jsonb)
  )
  into result;
  return result;
end;
$$;

create or replace function api_public_schedule(student_key text, class_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  target classes;
  monday date := current_date - (extract(isodow from current_date)::integer - 1);
  selected class_schedule_weeks;
begin
  perform require_student(api_public_schedule.student_key);
  select c.* into target
  from classes c
  where c.id = api_public_schedule.class_id and not c.archived;
  if not found then raise exception 'Không tìm thấy lớp'; end if;

  select w.* into selected
  from class_schedule_weeks w
  where w.class_id = target.id and w.week_start = monday;
  if not found and target.current_schedule_week is not null then
    select w.* into selected
    from class_schedule_weeks w
    where w.class_id = target.id and w.week_start = target.current_schedule_week;
  end if;

  return jsonb_build_object(
    'id', target.id,
    'name', target.name,
    'sessions', target.sessions,
    'courseKind', target.course_kind,
    'weekStart', coalesce(selected.week_start, monday)::text,
    'title', coalesce(selected.title, 'Tuần hiện tại'),
    'activeSlots', coalesce(selected.active_slots, target.current_slots),
    'slots', coalesce(selected.slots, target.final_subjects, '{}'::jsonb),
    'details', coalesce(selected.details, '{}'::jsonb)
  );
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
  perform require_class_manager(
    api_homeroom_schedule_sync.teacher_key,
    api_homeroom_schedule_sync.class_id
  );
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
      and (
        (api_homeroom_schedule_sync.record_type = 'LR'
          and slot.value ~ '^(LR|L|R)[0-9]+$')
        or slot.value ~ ('^' || api_homeroom_schedule_sync.record_type || '[0-9]+$')
      )
  ) q;
  return result;
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

  with raw_schedule as (
    select
      c.id as class_id,
      c.name as class_name,
      case
        when slot.value ~ '^(LR|L|R)[0-9]+$' then 'LR'
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
    where slot.value ~ '^(LR|L|R|S|W)[0-9]+$'
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
             + row_number() over (
               order by lower(s.student_name), s.student_name, s.dob
             ) - 1)::text
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
    'classId', e.class_id,
    'className', e.class_name,
    'recordType', e.record_type,
    'lessonIndex', e.lesson_index,
    'lessonTitle', e.lesson_title,
    'lessonLabel', e.lesson_label,
    'recordDate', e.record_date,
    'recordTeacher', e.record_teacher,
    'recordStartTime', e.record_start_time,
    'studentCount', e.student_count,
    'presentCount', e.present_count,
    'absentCount', e.absent_count,
    'entry', e.entry,
    'updatedAt', e.updated_at,
    'updatedBy', e.updated_by
  ) order by lower(e.class_name), e.class_name,
    case e.record_type when 'LR' then 1 when 'S' then 2 else 3 end,
    e.lesson_index), '[]'::jsonb)
  into result
  from expanded e;
  return result;
end;
$$;

grant execute on function api_schedule_class(text, text, date) to anon;
grant execute on function api_save_schedule_settings(text, text, text, jsonb) to anon;
grant execute on function api_save_schedule_week(text, text, date, text, jsonb, jsonb, text[], text[], jsonb) to anon;
grant execute on function api_save_schedule_extra_details(text, text, date, jsonb) to anon;
grant execute on function api_schedule_overview(text, date) to anon;
grant execute on function api_public_schedule(text, text) to anon;
grant execute on function api_homeroom_schedule_sync(text, text, text) to anon;
grant execute on function api_attendance_rows(text) to anon;
