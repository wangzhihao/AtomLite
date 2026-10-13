-- Atoms Lite 初始表结构（设计文档第 7 节）
-- 在 Supabase SQL Editor 中执行；并在 Authentication → Providers 中开启 Anonymous sign-ins。

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null default '未命名项目',
  current_version_id uuid,
  published_slug text unique,
  published_version_id uuid,
  remixed_from uuid references projects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  seq int not null,
  files jsonb not null,        -- {"App.jsx": "...", "styles.css": "..."}
  summary text,
  source text not null,        -- agent | autofix | restore | remix
  verified boolean,            -- 运行检查结果，null 表示待验证
  run_id uuid,
  created_at timestamptz not null default now(),
  unique (project_id, seq)
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  role text not null,          -- user | agent | system
  agent text,                  -- leader | planner | designer | engineer | fixer | advisor | qa
  content text not null,
  meta jsonb,                  -- 规划 JSON、文件列表、错误详情
  version_id uuid references versions(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null,
  intent text,                 -- create | edit | fix
  status text not null,        -- running | succeeded | failed | cancelled
  model text,
  first_pass boolean,
  fix_rounds int not null default 0,
  final_ok boolean,
  error_kinds text[],          -- syntax | runtime | console | blank
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cost_usd numeric(10,5),
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

alter table projects
  add constraint projects_current_version_fk foreign key (current_version_id) references versions(id) on delete set null,
  add constraint projects_published_version_fk foreign key (published_version_id) references versions(id) on delete set null;

create index if not exists versions_project_seq on versions(project_id, seq desc);
create index if not exists messages_project_created on messages(project_id, created_at);
create index if not exists runs_project_status on runs(project_id, status);
create index if not exists runs_user_started on runs(user_id, started_at);
create index if not exists projects_owner_updated on projects(owner_id, updated_at desc);

-- ---------------------------------------------------------------- RLS
alter table projects enable row level security;
alter table versions enable row level security;
alter table messages enable row level security;
alter table runs enable row level security;

create policy "own projects" on projects
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "own versions" on versions
  for all using (exists (select 1 from projects p where p.id = project_id and p.owner_id = auth.uid()))
  with check (exists (select 1 from projects p where p.id = project_id and p.owner_id = auth.uid()));

create policy "own messages" on messages
  for all using (exists (select 1 from projects p where p.id = project_id and p.owner_id = auth.uid()))
  with check (exists (select 1 from projects p where p.id = project_id and p.owner_id = auth.uid()));

create policy "own runs" on runs
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from projects p where p.id = project_id and p.owner_id = auth.uid()));
