CREATE TABLE IF NOT EXISTS laxnumbers_rankings (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  season        INT NOT NULL,
  rank_position INT NOT NULL,
  team_name     VARCHAR(100) NOT NULL,
  record        VARCHAR(20),
  wins          INT DEFAULT 0,
  losses        INT DEFAULT 0,
  rating        DECIMAL(8,3),
  agd           DECIMAL(8,3),
  sched         DECIMAL(8,3),
  scraped_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_rank (season, rank_position)
);

CREATE TABLE IF NOT EXISTS laxpower_rankings (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  season        INT NOT NULL,
  rank_position INT NOT NULL,
  team_name     VARCHAR(100) NOT NULL,
  record        VARCHAR(20),
  wins          INT DEFAULT 0,
  losses        INT DEFAULT 0,
  consensus     DECIMAL(8,3),
  scraped_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_rank (season, rank_position)
);

CREATE TABLE IF NOT EXISTS scrape_log (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  source        VARCHAR(50),
  teams_scraped INT,
  status        VARCHAR(20),
  error_message TEXT,
  scraped_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
