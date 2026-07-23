-- Recipes saved before instructions became an ordered-steps array store a
-- plain prose string in this column. Wrap each one as a single-element JSON
-- array so the app's JSON-mode read of this column keeps working for old
-- rows instead of throwing on invalid JSON.
UPDATE `recipes`
SET `instructions` = json_array(`instructions`)
WHERE `instructions` IS NOT NULL AND json_valid(`instructions`) = 0;
