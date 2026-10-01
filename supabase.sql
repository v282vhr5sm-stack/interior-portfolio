-- 인테리어 포트폴리오 — Supabase 설정 (견적 작업실과 같은 프로젝트)
-- Supabase 대시보드 > SQL Editor 에 이 내용을 전부 붙여넣고 Run 을 누르세요. (한 번만)

-- 현장
create table if not exists public.pf_sites (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  info jsonb not null default '{}'::jsonb,      -- 위치/평수/연도/설명
  hidden boolean not null default false,        -- true면 고객 링크에서 숨김
  cover uuid,                                   -- 대표 사진 id
  sort double precision not null default extract(epoch from now()),
  created_at timestamptz not null default now()
);

-- 사진 (site_id 가 비어 있으면 '현장명 없는 작업물')
create table if not exists public.pf_photos (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  site_id uuid references public.pf_sites(id) on delete cascade,
  phase text not null default 'after' check (phase in ('before', 'during', 'after')),
  space text not null default '기타',
  t text not null,            -- 썸네일 경로 (storage)
  l text not null,            -- 큰 사진 경로 (storage)
  w int, h int,
  src_name text, src_size bigint,
  created_at timestamptz not null default now()
);
create index if not exists pf_photos_site on public.pf_photos (site_id);

alter table public.pf_sites enable row level security;
alter table public.pf_photos enable row level security;

drop policy if exists "pf sites read" on public.pf_sites;
drop policy if exists "pf sites write" on public.pf_sites;
drop policy if exists "pf photos read" on public.pf_photos;
drop policy if exists "pf photos write" on public.pf_photos;

-- 누구나(고객) 숨기지 않은 현장/사진은 볼 수 있음, 주인은 전부 볼 수 있음
create policy "pf sites read" on public.pf_sites for select to anon, authenticated
  using (not hidden or owner = auth.uid());
create policy "pf photos read" on public.pf_photos for select to anon, authenticated
  using (owner = auth.uid() or site_id is null
         or exists (select 1 from public.pf_sites s where s.id = site_id and not s.hidden));
-- 쓰기는 로그인한 본인만
create policy "pf sites write" on public.pf_sites for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
create policy "pf photos write" on public.pf_photos for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

grant select on public.pf_sites, public.pf_photos to anon;
grant select, insert, update, delete on public.pf_sites, public.pf_photos to authenticated;

-- 사진 저장소 (공개 읽기, 쓰기는 본인 폴더만)
insert into storage.buckets (id, name, public) values ('portfolio', 'portfolio', true)
  on conflict (id) do update set public = true;
drop policy if exists "pf storage insert" on storage.objects;
drop policy if exists "pf storage update" on storage.objects;
drop policy if exists "pf storage delete" on storage.objects;
create policy "pf storage insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'portfolio' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "pf storage update" on storage.objects for update to authenticated
  using (bucket_id = 'portfolio' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "pf storage delete" on storage.objects for delete to authenticated
  using (bucket_id = 'portfolio' and (storage.foldername(name))[1] = auth.uid()::text);

-- 실시간 반영 (다른 기기에서 올린 사진이 바로 보이게)
do $$ begin
  alter publication supabase_realtime add table public.pf_sites;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.pf_photos;
exception when duplicate_object then null; end $$;
