-- Run this block in Supabase SQL Editor to show timestamps on pending submissions.

create or replace function teacher_submission_json(s submissions)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'studentName', coalesce(st.student_name, s.student_name),
    'dob', coalesce(st.dob, s.dob)::text,
    'busySlots', s.busy_slots,
    'otherClassSlots', submission_other_class_slots(s),
    'status', s.status,
    'updatedAt', s.updated_at,
    'studentId', s.student_id,
    'classIds', coalesce((
      select jsonb_agg(x.class_id order by lower(c.name), c.name, x.class_id)
      from submissions x
      join classes c on c.id = x.class_id and not c.archived
      left join students xst on xst.id = x.student_id
      where coalesce(xst.name_key, x.name_key) = coalesce(st.name_key, s.name_key)
        and coalesce(xst.dob, x.dob) = coalesce(st.dob, s.dob)
    ), '[]'::jsonb)
  )
  from (select 1) one
  left join students st on st.id = s.student_id;
$$;

grant execute on all functions in schema public to anon;
