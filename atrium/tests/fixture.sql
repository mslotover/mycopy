-- Accounts and spaces scripts/api-test.mjs expects, on a freshly migrated local database.
INSERT INTO users (id, email, name, role, created_at) VALUES
  ('t-owner', 'owner@example.com', 'Olive Owner', 'owner', 0),
  ('t-sam', 'sam@example.com', 'Sam Member', 'member', 0),
  ('t-guest', 'guest@example.com', 'Gus Guest', 'guest', 0);
INSERT INTO spaces (id, name, sort, created_at) VALUES ('t-rest', 'Restaurant', 1, 0), ('t-bake', 'Bakery', 2, 0);
INSERT INTO space_members (space_id, user_id) VALUES ('t-rest', 't-owner'), ('t-bake', 't-owner'), ('t-rest', 't-sam');
