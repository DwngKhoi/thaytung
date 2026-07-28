-- Olympus schedule v3
-- Run once after schedule_v2.sql. Adds four independently saved lanes per class slot.

create or replace function clean_schedule_lane(value jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select jsonb_build_object(
    'active', lower(coalesce(value ->> 'active', 'false')) = 'true',
    'lesson', case
      when upper(clean_name(value ->> 'lesson')) ~
        '^(S[0-9]*|W[0-9]*|LR[0-9]*|L[0-9]*|R[0-9]*|MT[12]?|FT[12]?|OFF|LESSON|REVIEW)$'
      then upper(clean_name(value ->> 'lesson')) else '' end,
    'lessonType', case
      when upper(clean_name(value ->> 'lessonType')) ~ '^(LR|L|R|W|S|MT|FT|OFF|LESSON)$'
      then upper(clean_name(value ->> 'lessonType')) else '' end,
    'courseNo', case
      when clean_name(value ->> 'courseNo') ~ '^[0-9]+[ab]?$'
      then clean_name(value ->> 'courseNo') else '' end,
    'location', left(clean_name(value ->> 'location'), 80),
    'note', left(clean_name(value ->> 'note'), 300),
    'startTime', case
      when clean_name(value ->> 'startTime') ~ '^[0-2][0-9]:[0-5][0-9]$'
      then clean_name(value ->> 'startTime') else '' end,
    'teacherName', left(clean_name(value ->> 'teacherName'), 120)
  );
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
      then upper(clean_name(d.value ->> 'lessonType')) else '' end,
    'primaryLane', least(3, greatest(0, coalesce(
      case when (d.value ->> 'primaryLane') ~ '^[0-3]$'
        then (d.value ->> 'primaryLane')::integer end,
      0
    ))),
    'lanes', coalesce((
      select jsonb_agg(clean_schedule_lane(lane.value) order by lane.ord)
      from jsonb_array_elements(
        case when jsonb_typeof(d.value -> 'lanes') = 'array'
          then d.value -> 'lanes' else '[]'::jsonb end
      ) with ordinality lane(value, ord)
      where lane.ord <= 4
    ), '[]'::jsonb)
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

  update classes c
  set current_schedule_week = api_save_schedule_extra_details.week_start
  where c.id = api_save_schedule_extra_details.class_id;

  return jsonb_build_object('ok', true);
end;
$$;

-- Current-week overview follows the latest yellow cells immediately, even
-- before the owner opens and saves the per-class planner again.
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
  requested date := coalesce(api_schedule_overview.week_start, current_monday);
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
        'activeSlots', case
          when requested = current_monday then c.current_slots
          else coalesce(w.active_slots, '{}'::text[]) end,
        'slots', case
          when requested = current_monday then coalesce(nullif(w.slots, '{}'::jsonb), c.final_subjects, '{}'::jsonb)
          else coalesce(w.slots, '{}'::jsonb) end,
        'details', case
          when w.id is not null then coalesce(w.details, '{}'::jsonb)
          when requested = current_monday then coalesce((
            select cw.details from class_schedule_weeks cw
            where cw.class_id = c.id
            order by
              case when cw.week_start = c.current_schedule_week then 0 else 1 end,
              cw.week_start desc
            limit 1
          ), '{}'::jsonb)
          else '{}'::jsonb end
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

grant execute on function clean_schedule_lane(jsonb) to anon;
grant execute on function api_save_schedule_extra_details(text, text, date, jsonb) to anon;
grant execute on function api_schedule_overview(text, date) to anon;
