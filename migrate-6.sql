-- 911 customer contact email (mandatory for new customers, used for NO ELIN alerts) + numbers may be loaded without an ELIN address
ALTER TABLE customers ADD COLUMN IF NOT EXISTS contact_email text;
ALTER TABLE dids ALTER COLUMN elin_address1 DROP NOT NULL;
