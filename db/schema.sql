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

CREATE TABLE IF NOT EXISTS team_schedules (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  team_id        VARCHAR(50)  NOT NULL,
  game_date      DATE         NOT NULL,
  game_time      VARCHAR(20),
  opponent       VARCHAR(100) NOT NULL,
  is_home        BOOLEAN      DEFAULT true,
  is_conference  BOOLEAN      DEFAULT false,
  result         VARCHAR(5),
  team_score     INT,
  opp_score      INT,
  is_ot          BOOLEAN      DEFAULT false,
  season         INT          NOT NULL DEFAULT 2026,
  scraped_at     DATETIME     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_game (team_id, game_date, opponent, game_time)
);

CREATE TABLE IF NOT EXISTS scrape_log (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  source        VARCHAR(50),
  teams_scraped INT,
  status        VARCHAR(20),
  error_message TEXT,
  scraped_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
