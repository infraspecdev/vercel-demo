-- Inventory POC schema for the Supabase observability demo.
-- Paste into the Supabase SQL Editor and run once.
--
-- Shape chosen so the platform metrics actually move:
--   stock      -> hot point reads
--   movements  -> append-only, grows, drives WAL and disk write metrics
--   items      -> joins and filtered scans
-- Row Level Security is disabled deliberately. With RLS on and no policies,
-- PostgREST returns 200 with an empty array and no error, which is a long
-- debugging detour in a POC. Not a production recommendation.

drop table if exists purchase_order_lines cascade;
drop table if exists purchase_orders cascade;
drop table if exists movements cascade;
drop table if exists stock cascade;
drop table if exists items cascade;
drop table if exists locations cascade;
drop table if exists suppliers cascade;

create table locations (
  id          serial primary key,
  code        text not null unique,
  name        text not null,
  kind        text not null check (kind in ('warehouse','store','outlet','transit'))
);

create table suppliers (
  id          serial primary key,
  name        text not null,
  lead_days   int  not null default 7
);

create table items (
  id              serial primary key,
  sku             text not null unique,
  name            text not null,
  category        text not null,
  unit            text not null,
  reorder_level   int  not null default 20,
  unit_cost       numeric(10,2) not null default 0,
  supplier_id     int references suppliers(id)
);

create table stock (
  item_id     int not null references items(id),
  location_id int not null references locations(id),
  quantity    int not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (item_id, location_id)
);

-- append-only ledger; this is the table that grows during the demo
create table movements (
  id           bigserial primary key,
  item_id      int not null references items(id),
  location_id  int not null references locations(id),
  kind         text not null check (kind in ('receipt','issue','transfer','adjustment')),
  quantity     int not null,
  reference    text,
  created_at   timestamptz not null default now()
);

create table purchase_orders (
  id           serial primary key,
  supplier_id  int not null references suppliers(id),
  status       text not null default 'open' check (status in ('open','received','cancelled')),
  created_at   timestamptz not null default now()
);

create table purchase_order_lines (
  id          serial primary key,
  po_id       int not null references purchase_orders(id),
  item_id     int not null references items(id),
  quantity    int not null
);

-- indexes the demo queries rely on
create index on movements (item_id, created_at desc);
create index on movements (created_at desc);
create index on items (category);
create index on stock (location_id);

-- POC only: see the note at the top of this file
alter table locations            disable row level security;
alter table suppliers            disable row level security;
alter table items                disable row level security;
alter table stock                disable row level security;
alter table movements            disable row level security;
alter table purchase_orders      disable row level security;
alter table purchase_order_lines disable row level security;

-- ---------------------------------------------------------------- seed data

insert into locations (code, name, kind) values
  ('WH-A',    'Warehouse A','warehouse'),
  ('WH-B',    'Warehouse B','warehouse'),
  ('WH-C',    'Warehouse C','warehouse'),
  ('HUB',     'Distribution Hub','warehouse'),
  ('STORE-1', 'Store 1','store'),
  ('STORE-2', 'Store 2','store'),
  ('OUTLET',  'Outlet','outlet'),
  ('TRANSIT', 'In Transit','transit');

insert into suppliers (name, lead_days) values
  ('Northwind Supply', 5),
  ('Acme Components', 10),
  ('Global Parts Direct', 3),
  ('Summit Industrial', 14);

-- 240 items across realistic categories
insert into items (sku, name, category, unit, reorder_level, unit_cost, supplier_id)
select
  'SKU-' || lpad(g::text, 5, '0'),
  (array['Cable','Adapter','Bracket','Fastener','Bearing','Filter',
         'Gasket','Hose','Sensor','Switch','Valve','Washer'])
    [1 + (g % 12)] || ' ' ||
  (array['5mm','10mm','20mm','Small','Medium','Large','Standard','Heavy-Duty'])[1 + (g % 8)],
  (array['components','hardware','consumables','electrical','packaging'])[1 + (g % 5)],
  (array['each','box','pack','case'])[1 + (g % 4)],
  10 + (g % 40),
  round((2 + (g % 180) * 0.75)::numeric, 2),
  1 + (g % 4)
from generate_series(1, 240) g;

-- stock for every item in every location
insert into stock (item_id, location_id, quantity)
select i.id, l.id, 5 + ((i.id * l.id) % 250)
from items i cross join locations l;

-- 5000 rows of movement history so reports have something to read
insert into movements (item_id, location_id, kind, quantity, reference, created_at)
select
  1 + (g % 240),
  1 + (g % 8),
  (array['receipt','issue','issue','transfer','adjustment'])[1 + (g % 5)],
  1 + (g % 30),
  'SEED-' || g,
  now() - ((g % 2880) || ' minutes')::interval
from generate_series(1, 5000) g;

analyze;

select
  (select count(*) from items)     as items,
  (select count(*) from locations) as locations,
  (select count(*) from stock)     as stock_rows,
  (select count(*) from movements) as movements;
