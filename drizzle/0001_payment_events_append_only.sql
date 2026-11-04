CREATE FUNCTION payment_events_reject_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'payment_events is append-only'; END; $$;
--> statement-breakpoint
CREATE TRIGGER payment_events_no_update BEFORE UPDATE ON payment_events
FOR EACH ROW EXECUTE FUNCTION payment_events_reject_update();
