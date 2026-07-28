const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const supabaseDir = path.join(root, 'supabase');
const migrations = [
  'student_profiles.sql',
  'homeroom_records.sql',
  'attendance_profile.sql',
  'vocab_schedule_sync.sql',
  'submission_timestamps.sql',
  'schedule_v2.sql',
  'schedule_v3.sql',
  'personalization_v4.sql',
  'schedule_templates_v5.sql'
];

let output = `-- OLYMPUS ALL IN ONE - UPGRADE EXISTING PROJECT
-- Dan toan bo file nay vao mot Supabase SQL Editor query va bam Run mot lan.
-- Co the chay lai; khong xoa lop, hoc sinh hay cac tuan lich hien co.

begin;
`;

migrations.forEach((file) => {
  const source = fs.readFileSync(path.join(supabaseDir, file), 'utf8')
    .replace(/^\uFEFF/, '')
    .trim();
  output += `

-- ============================================================================
-- ${file}
-- ============================================================================

${source}
`;
});

output += '\ncommit;\n';
fs.writeFileSync(path.join(supabaseDir, 'OLYMPUS_ALL_IN_ONE.sql'), output, 'utf8');
console.log(`Built OLYMPUS_ALL_IN_ONE.sql from ${migrations.length} migrations.`);
