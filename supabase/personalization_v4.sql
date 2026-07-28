-- Olympus personalization v4
-- Run once after schedule_v3.sql. Stores the shared operating profile, presets,
-- symbol palette and locations as one compact JSON document.

insert into app_settings (key, value)
values ('OLYMPUS_PERSONALIZATION', '{}')
on conflict (key) do nothing;

create or replace function api_personalization_profile(teacher_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  raw_value text;
begin
  perform require_teacher(api_personalization_profile.teacher_key);
  select s.value into raw_value
  from app_settings s
  where s.key = 'OLYMPUS_PERSONALIZATION';

  if coalesce(raw_value, '') = '' then return '{}'::jsonb; end if;
  begin
    return raw_value::jsonb;
  exception when others then
    return '{}'::jsonb;
  end;
end;
$$;

create or replace function api_public_personalization(student_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  full_profile jsonb := '{}'::jsonb;
  raw_value text;
begin
  perform require_student(api_public_personalization.student_key);
  select s.value into raw_value
  from app_settings s
  where s.key = 'OLYMPUS_PERSONALIZATION';
  begin
    full_profile := coalesce(raw_value::jsonb, '{}'::jsonb);
  exception when others then
    full_profile := '{}'::jsonb;
  end;
  return jsonb_build_object(
    'version', 1,
    'centerName', coalesce(full_profile ->> 'centerName', 'Olympus English'),
    'symbols', coalesce(full_profile -> 'symbols', '[]'::jsonb),
    'locations', coalesce(full_profile -> 'locations', '[]'::jsonb)
  );
end;
$$;

create or replace function api_save_personalization_profile(
  teacher_key text,
  profile jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_profile jsonb := coalesce(api_save_personalization_profile.profile, '{}'::jsonb);
begin
  perform require_owner(api_save_personalization_profile.teacher_key);
  if jsonb_typeof(clean_profile) <> 'object' then
    raise exception 'Cấu hình Olympus phải là một object';
  end if;
  if octet_length(clean_profile::text) > 131072 then
    raise exception 'Cấu hình Olympus vượt quá 128 KB';
  end if;

  insert into app_settings (key, value)
  values ('OLYMPUS_PERSONALIZATION', clean_profile::text)
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('ok', true, 'profile', clean_profile);
end;
$$;

grant execute on function api_personalization_profile(text) to anon;
grant execute on function api_public_personalization(text) to anon;
grant execute on function api_save_personalization_profile(text, jsonb) to anon;
