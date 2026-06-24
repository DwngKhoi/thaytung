// Copy file nay thanh config.js.
// Cach khuyen dung: Supabase. Khi co SUPABASE_URL + SUPABASE_ANON_KEY,
// frontend se uu tien Supabase va khong goi Apps Script.
window.SUPABASE_URL = 'https://PROJECT_REF.supabase.co';
window.SUPABASE_ANON_KEY = 'SUPABASE_ANON_KEY';

// Key co ban dung trong RPC Supabase hoac Apps Script.
window.STUDENT_KEY = 'CHANGE_STUDENT_KEY';
window.TEACHER_KEY = 'CHANGE_TEACHER_KEY';

// Fallback cu: chi dung khi chua dien Supabase.
window.GAS_API_URL = 'https://script.google.com/macros/s/DEPLOYMENT_ID/exec';
