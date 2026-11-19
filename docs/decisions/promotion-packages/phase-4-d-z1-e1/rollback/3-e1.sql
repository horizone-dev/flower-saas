-- PROMOTION ROLLBACK 3 of 3 (E1: expenses & other income) — UNAPPLIED. Safe only while the tables hold no rows; afterwards they are evidence and are kept. Run 3, then 2, then 1.

-- the functions that take the expense ROW TYPE go first (a table cannot be dropped while a function depends on its type), then the tables, then the rest
DROP FUNCTION fn_expense_assert_session("expense");
DROP FUNCTION fn_expense_assert_category("expense");
DROP FUNCTION fn_expense_assert_creator("expense");
DROP TABLE "expense_event";
DROP TABLE "expense";
DROP TABLE "expense_category";
DROP TABLE "other_income";
DROP FUNCTION fn_expense_event_matches_status();
DROP FUNCTION fn_expense_requires_event();
DROP FUNCTION fn_expense_event_append_only();
DROP FUNCTION fn_expense_event_guard();
DROP FUNCTION fn_expense_update_guard();
DROP FUNCTION fn_expense_insert_guard();
DROP FUNCTION fn_expense_category_guard();
DROP FUNCTION fn_other_income_guard();
DROP FUNCTION fn_p47_no_truncate();
DROP FUNCTION fn_p47_no_delete();
DROP FUNCTION fn_p47_user_in_tenant(UUID, UUID);
