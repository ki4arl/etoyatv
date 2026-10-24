CREATE TABLE IF NOT EXISTS pending_team_invites (
  id INT AUTO_INCREMENT PRIMARY KEY,
  channel_id INT NOT NULL,
  inviter_id INT NOT NULL,
  invitee_id INT NOT NULL,
  is_reporter TINYINT(1) NOT NULL DEFAULT 0,
  is_moderator TINYINT(1) NOT NULL DEFAULT 0,
  is_editor TINYINT(1) NOT NULL DEFAULT 0,
  is_coowner TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('pending','accepted','rejected','cancelled') NOT NULL DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_invitee_pending (invitee_id, status),
  KEY idx_channel_pending (channel_id, status),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (inviter_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (invitee_id) REFERENCES users(id) ON DELETE CASCADE
);
