CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  info TEXT NOT NULL DEFAULT '{}',
  hidden INTEGER NOT NULL DEFAULT 0,
  cover TEXT,
  sort REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  site_id TEXT,
  phase TEXT NOT NULL DEFAULT 'after',
  space TEXT NOT NULL DEFAULT '기타',
  t TEXT NOT NULL,
  l TEXT NOT NULL,
  w INTEGER, h INTEGER,
  src_name TEXT, src_size INTEGER,
  type TEXT NOT NULL DEFAULT 'image',   -- image | video | main(현장 메인파일)
  ord INTEGER NOT NULL DEFAULT 0,          -- 메인파일 페이지 순서
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_site ON photos (site_id);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
