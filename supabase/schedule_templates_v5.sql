-- Olympus schedule templates and conflict center v5
-- Safe to run repeatedly after personalization_v4.sql.

create table if not exists schedule_templates (
  id uuid primary key default gen_random_uuid(),
  class_id text not null references classes(id) on delete cascade,
  name text not null,
  template_mode text not null default 'structure'
    check (template_mode in ('structure', 'full')),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists schedule_templates_class_idx
  on schedule_templates (class_id, lower(name), created_at);

alter table schedule_templates enable row level security;
drop policy if exists "deny direct schedule_templates" on schedule_templates;
create policy "deny direct schedule_templates"
  on schedule_templates for all using (false) with check (false);

create or replace function api_schedule_templates(
  teacher_key text,
  class_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform require_class_manager(
    api_schedule_templates.teacher_key,
    api_schedule_templates.class_id
  );
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id,
      'classId', t.class_id,
      'name', t.name,
      'mode', t.template_mode,
      'data', t.data,
      'updatedAt', t.updated_at
    ) order by lower(t.name), t.name, t.created_at, t.id)
    from schedule_templates t
    where t.class_id = api_schedule_templates.class_id
  ), '[]'::jsonb);
end;
$$;

create or replace function api_save_schedule_template(
  teacher_key text,
  class_id text,
  template_id uuid,
  template_name text,
  template_mode text,
  template_data jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  saved_id uuid;
  clean_name_value text := left(clean_name(api_save_schedule_template.template_name), 100);
  clean_mode text := case
    when lower(coalesce(api_save_schedule_template.template_mode, '')) = 'full' then 'full'
    else 'structure'
  end;
  clean_data jsonb := coalesce(api_save_schedule_template.template_data, '{}'::jsonb);
begin
  perform require_class_manager(
    api_save_schedule_template.teacher_key,
    api_save_schedule_template.class_id
  );
  if clean_name_value = '' then raise exception 'Nhập tên mẫu tuần'; end if;
  if jsonb_typeof(clean_data) <> 'object' then
    raise exception 'Dữ liệu mẫu tuần không hợp lệ';
  end if;
  if octet_length(clean_data::text) > 131072 then
    raise exception 'Mẫu tuần vượt quá 128 KB';
  end if;

  if api_save_schedule_template.template_id is null then
    insert into schedule_templates (class_id, name, template_mode, data)
    values (
      api_save_schedule_template.class_id,
      clean_name_value,
      clean_mode,
      clean_data
    )
    returning id into saved_id;
  else
    update schedule_templates t
    set name = clean_name_value,
        template_mode = clean_mode,
        data = clean_data,
        updated_at = now()
    where t.id = api_save_schedule_template.template_id
      and t.class_id = api_save_schedule_template.class_id
    returning t.id into saved_id;
    if saved_id is null then raise exception 'Không tìm thấy mẫu tuần'; end if;
  end if;

  return jsonb_build_object('ok', true, 'id', saved_id);
end;
$$;

create or replace function api_delete_schedule_template(
  teacher_key text,
  class_id text,
  template_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform require_class_manager(
    api_delete_schedule_template.teacher_key,
    api_delete_schedule_template.class_id
  );
  delete from schedule_templates t
  where t.id = api_delete_schedule_template.template_id
    and t.class_id = api_delete_schedule_template.class_id;
  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function api_schedule_templates(text, text) to anon;
grant execute on function api_save_schedule_template(text, text, uuid, text, text, jsonb) to anon;
grant execute on function api_delete_schedule_template(text, text, uuid) to anon;
