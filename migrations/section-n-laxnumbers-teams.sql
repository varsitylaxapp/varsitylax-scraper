-- Section N — what the LaxNumbers game import remembers between runs
--
-- One row per rated team per season: its LaxNumbers team number, the team it resolved to,
-- its games-played at the last committed read of its page, and when that was.
--
-- WHY. The cron starts with nothing in memory, and a full pass is 144 team pages. With
-- games-played stored, a run fetches only the pages whose gp moved (src/laxnumbers-games/
-- teams.js), plus every page once per Pacific day, since a score correction or a new
-- fixture does not move gp.
--
-- IDENTITY. team_nbr → team_id survives a rename on either side: when LaxNumbers renames a
-- team and the name no longer finds it, the stored id does. A stored id that DISAGREES
-- with a fresh lookup is never followed: the team is refused and logged until a human
-- looks.
--
-- KEYED ON SEASON. Whether LaxNumbers keeps a team's number from one season to the next
-- is not verified, so nothing carries over.
--
-- A row is written in the same transaction as that team's games, so a page whose games
-- did not commit (a failure, the request cap, an unresolved opponent) has no new row and
-- is read again next run.
--
-- ON DELETE CASCADE: a team removed by a merge takes its row with it, and the next run
-- resolves that number afresh.
--
-- Additive: a new table, no existing row changes, nothing in the API reads it.

CREATE TABLE IF NOT EXISTS laxnumbers_teams (
  season      SMALLINT NOT NULL,
  state       CHAR(2)  NOT NULL,            -- the feed the team is rated in
  team_nbr    INT UNSIGNED NOT NULL,        -- LaxNumbers' t= number
  team_id     INT UNSIGNED NOT NULL,        -- teams.id
  gp          INT      NULL,                -- games played, from the ratings service
  fetched_at  DATETIME NOT NULL,            -- UTC, when the page's games were committed
  PRIMARY KEY (season, state, team_nbr),
  KEY idx_laxnumbers_teams_team (team_id),
  CONSTRAINT fk_laxnumbers_teams_team FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE
);
