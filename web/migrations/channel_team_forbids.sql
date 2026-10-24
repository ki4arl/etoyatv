-- Channel team / co-owner admin forbids
ALTER TABLE channels
  ADD COLUMN team_assign_disabled BOOLEAN DEFAULT FALSE,
  ADD COLUMN coowners_disabled BOOLEAN DEFAULT FALSE,
  ADD COLUMN team_change_disabled BOOLEAN DEFAULT FALSE;
