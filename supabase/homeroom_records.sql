-- Run this block in Supabase SQL Editor to enable durable homeroom records.

create table if not exists homeroom_records (
  class_id text not null references classes(id) on delete cascade,
  record_type text not null check (record_type in ('LR', 'S', 'W')),
  cells jsonb not null default '{}'::jsonb,
  styles jsonb not null default '{}'::jsonb,
  lesson_count integer not null default 3 check (lesson_count between 1 and 300),
  updated_at timestamptz not null default now(),
  primary key (class_id, record_type)
);

alter table homeroom_records enable row level security;
drop policy if exists "deny direct homeroom_records" on homeroom_records;
create policy "deny direct homeroom_records" on homeroom_records for all using (false) with check (false);

drop function if exists api_homeroom_record(text, text, text);
create or replace function api_homeroom_record(teacher_key text, class_id text, record_type text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  rec homeroom_records;
begin
  perform require_class_manager(api_homeroom_record.teacher_key, api_homeroom_record.class_id);
  if api_homeroom_record.record_type not in ('LR', 'S', 'W') then
    raise exception 'Invalid homeroom record type';
  end if;

  select * into rec
  from homeroom_records h
  where h.class_id = api_homeroom_record.class_id
    and h.record_type = api_homeroom_record.record_type;

  if not found then
    return jsonb_build_object('cells', '{}'::jsonb, 'styles', '{}'::jsonb, 'lessonCount', 3);
  end if;

  return jsonb_build_object(
    'cells', coalesce(rec.cells, '{}'::jsonb),
    'styles', coalesce(rec.styles, '{}'::jsonb),
    'lessonCount', coalesce(rec.lesson_count, 3),
    'updatedAt', rec.updated_at
  );
end;
$$;

drop function if exists api_save_homeroom_record(text, text, text, jsonb, jsonb, integer);
create or replace function api_save_homeroom_record(
  teacher_key text,
  class_id text,
  record_type text,
  cells jsonb,
  styles jsonb,
  lesson_count integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_lesson_count integer := greatest(1, least(coalesce(api_save_homeroom_record.lesson_count, 3), 300));
begin
  perform require_class_manager(api_save_homeroom_record.teacher_key, api_save_homeroom_record.class_id);
  if api_save_homeroom_record.record_type not in ('LR', 'S', 'W') then
    raise exception 'Invalid homeroom record type';
  end if;

  insert into homeroom_records as h (class_id, record_type, cells, styles, lesson_count, updated_at)
  values (
    api_save_homeroom_record.class_id,
    api_save_homeroom_record.record_type,
    coalesce(api_save_homeroom_record.cells, '{}'::jsonb),
    coalesce(api_save_homeroom_record.styles, '{}'::jsonb),
    safe_lesson_count,
    now()
  )
  on conflict (class_id, record_type) do update
    set cells = excluded.cells,
        styles = excluded.styles,
        lesson_count = excluded.lesson_count,
        updated_at = now();

  return jsonb_build_object('ok', true, 'lessonCount', safe_lesson_count);
end;
$$;

grant execute on all functions in schema public to anon;
