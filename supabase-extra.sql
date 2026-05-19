-- טבלת לוג שגיאות (הוסף ל-Supabase SQL Editor)
create table if not exists nv_error_log (
  id          bigserial primary key,
  document_id bigint,
  queue_id    bigint,
  error_msg   text,
  stack_trace text,
  created_at  timestamptz default now()
);
