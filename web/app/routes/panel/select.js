// Panel channel selection
const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const { requireAuth } = require('../../../middlewares/auth');
const { roleListRu } = require('../../../utils/teamInvite');
const { revokeUserStreamAccess } = require('../../../utils/streamAccess');
const { recordTeamDeparture, assertNoTeamRejoinCooldown } = require('../../../utils/teamCooldown');

router.get('/ru/panel,select', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  try {
    const connection = await pool.getConnection();
    const isStaff = req.session.user.staff_role && req.session.user.mask_mode !== 'user_mask';

    // If channel_id query param is provided and user is staff, enter as temporary owner
    // until they switch to another channel (panel_staff_channel_id session).
    if (req.query.channel_id && isStaff) {
      const [ch] = await connection.query("SELECT id FROM channels WHERE id = ? AND status IN ('active', 'banned', 'pending_approval', 'rejected_approval')", [req.query.channel_id]);
      if (ch.length > 0) {
        req.session.panel_channel_id = ch[0].id;
        req.session.panel_staff_channel_id = ch[0].id;
        connection.release();
        return res.redirect('/panel,dashboard');
      }
    }

    const [ownedChannels] = await connection.query("SELECT c.*, 'owner' as panel_role FROM channels c WHERE c.user_id = ? AND c.status IN ('active', 'banned', 'pending_approval', 'rejected_approval')", [req.session.user.id]);
    const [teamChannels] = await connection.query("SELECT c.*, t.is_editor, t.is_reporter, t.is_coowner FROM channels c JOIN channel_team t ON c.id = t.channel_id WHERE t.user_id = ? AND c.status IN ('active', 'banned', 'pending_approval', 'rejected_approval') AND (t.is_editor = 1 OR t.is_reporter = 1 OR t.is_coowner = 1)", [req.session.user.id]);

    let availableChannels = [...ownedChannels, ...teamChannels.map(c => {
      let role = 'reporter';
      if (c.is_coowner) role = 'coowner';
      else if (c.is_editor) role = 'editor';
      return { ...c, panel_role: role };
    })];
    availableChannels = availableChannels.map((c) => (
      Number(c.user_id) === Number(req.session.user.id) ? { ...c, panel_role: 'owner' } : c
    ));

    // Active "temporary owner" session: show staff role for that channel only
    const staffSessionId = req.session.panel_staff_channel_id;
    if (isStaff && staffSessionId) {
      let found = false;
      availableChannels = availableChannels.map((c) => {
        if (c.id == staffSessionId) {
          found = true;
          return { ...c, panel_role: 'staff' };
        }
        return c;
      });
      if (!found) {
        const [staffSelectedChannel] = await connection.query("SELECT c.*, 'staff' as panel_role FROM channels c WHERE c.id = ? AND c.status IN ('active', 'banned', 'pending_approval', 'rejected_approval')", [staffSessionId]);
        if (staffSelectedChannel.length > 0) {
          availableChannels.push(staffSelectedChannel[0]);
        } else {
          delete req.session.panel_staff_channel_id;
        }
      }
    } else if (isStaff && req.session.panel_channel_id) {
      // Legacy: channel only available via staff, no team membership
      const isAlreadyAvailable = availableChannels.some(c => c.id == req.session.panel_channel_id);
      if (!isAlreadyAvailable) {
        const [staffSelectedChannel] = await connection.query("SELECT c.*, 'staff' as panel_role FROM channels c WHERE c.id = ? AND c.status IN ('active', 'banned', 'pending_approval', 'rejected_approval')", [req.session.panel_channel_id]);
        if (staffSelectedChannel.length > 0) {
          availableChannels.push(staffSelectedChannel[0]);
        }
      }
    }

    // Leave team: not owner, not coowner, not staff temp owner
    availableChannels = availableChannels.map((c) => ({
      ...c,
      can_leave_team: c.panel_role === 'reporter' || c.panel_role === 'editor'
    }));

    const [pendingTransfers] = await connection.query(`
      SELECT t.id as transfer_id, t.created_at, c.name as channel_name, c.shortname, u.username as old_owner_username
      FROM pending_channel_transfers t
      JOIN channels c ON t.channel_id = c.id
      JOIN users u ON t.old_owner_id = u.id
      WHERE t.new_owner_id = ? AND t.email_confirmed = TRUE
    `, [req.session.user.id]);

    const [pendingTeamInvites] = await connection.query(`
      SELECT i.id as invite_id, i.is_reporter, i.is_moderator, i.is_editor, i.is_coowner,
             c.name as channel_name, c.shortname, u.username as inviter_username
      FROM pending_team_invites i
      JOIN channels c ON i.channel_id = c.id
      JOIN users u ON i.inviter_id = u.id
      WHERE i.invitee_id = ? AND i.status = 'pending'
      ORDER BY i.created_at DESC
    `, [req.session.user.id]);

    const pendingInvites = pendingTeamInvites.map((inv) => ({
      ...inv,
      role_text: roleListRu(inv)
    }));

    connection.release();

    if (availableChannels.length === 1 && !isStaff && pendingTransfers.length === 0 && pendingInvites.length === 0 && req.query.to !== 'channel') {
      req.session.panel_channel_id = availableChannels[0].id;
      return res.redirect('/panel,dashboard');
    }

    const to = req.query.to || '';
    const pageTitle = to === 'channel' ? 'Мои каналы | ЭтоЯTV' : 'Выбор телеканала | Панель управления | ЭтоЯTV';
    res.render('panel/select', { pageTitle, availableChannels, pendingTransfers, pendingInvites, to });
  } catch (e) {
    console.error('Error loading channels:', e);
    res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,team,leave', requireAuth, async (req, res) => {
  const channelId = parseInt(req.body.channel_id, 10);
  if (!channelId) return res.status(400).send('channel_id required');

  try {
    const [chRows] = await pool.query(
      "SELECT id, user_id, name, shortname FROM channels WHERE id = ? AND status IN ('active', 'banned', 'pending_approval', 'rejected_approval')",
      [channelId]
    );
    if (chRows.length === 0) return res.status(404).send('Канал не найден');
    if (Number(chRows[0].user_id) === Number(req.session.user.id)) {
      return res.status(403).send('Владелец канала не может покинуть команду');
    }

    const [teamRows] = await pool.query(
      'SELECT is_coowner FROM channel_team WHERE channel_id = ? AND user_id = ?',
      [channelId, req.session.user.id]
    );
    if (teamRows.length === 0) return res.status(404).send('Вы не состоите в команде этого канала');
    if (teamRows[0].is_coowner) {
      return res.status(403).send('Совладелец не может покинуть команду самостоятельно');
    }

    await pool.query('DELETE FROM channel_team WHERE channel_id = ? AND user_id = ?', [channelId, req.session.user.id]);
    await pool.query(
      "UPDATE pending_team_invites SET status = 'cancelled' WHERE channel_id = ? AND invitee_id = ? AND status = 'pending'",
      [channelId, req.session.user.id]
    );
    try {
      await recordTeamDeparture(pool, channelId, req.session.user.id);
    } catch (cdErr) {
      console.error('Error recording team rejoin cooldown on leave:', cdErr);
    }
    try {
      await revokeUserStreamAccess(pool, {
        channelId,
        userId: req.session.user.id,
        shortname: chRows[0].shortname,
        io: req.app.get('io')
      });
    } catch (revErr) {
      console.error('Error revoking stream on team leave:', revErr);
    }

    if (String(req.session.panel_channel_id) === String(channelId)) {
      delete req.session.panel_channel_id;
    }
    if (String(req.session.panel_staff_channel_id) === String(channelId)) {
      delete req.session.panel_staff_channel_id;
    }

    return res.json({ success: true });
  } catch (e) {
    console.error('Error leaving team:', e);
    return res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,team,invite,accept', requireAuth, async (req, res) => {
  const inviteId = parseInt(req.body.invite_id, 10);
  if (!inviteId) return res.status(400).send('invite_id required');

  try {
    const connection = await pool.getConnection();
    const [invRows] = await connection.query(
      "SELECT * FROM pending_team_invites WHERE id = ? AND invitee_id = ? AND status = 'pending'",
      [inviteId, req.session.user.id]
    );
    if (invRows.length === 0) {
      connection.release();
      return res.status(404).send('Приглашение не найдено');
    }
    const inv = invRows[0];

    const [chRows] = await connection.query(
      "SELECT id, user_id, name FROM channels WHERE id = ? AND status IN ('active', 'banned', 'pending_approval', 'rejected_approval')",
      [inv.channel_id]
    );
    if (chRows.length === 0) {
      await connection.query("UPDATE pending_team_invites SET status = 'cancelled' WHERE id = ?", [inviteId]);
      connection.release();
      return res.status(404).send('Канал не найден');
    }
    if (Number(chRows[0].user_id) === Number(req.session.user.id)) {
      await connection.query("UPDATE pending_team_invites SET status = 'cancelled' WHERE id = ?", [inviteId]);
      connection.release();
      return res.status(400).send('Вы уже владелец этого канала');
    }

    const [existing] = await connection.query(
      'SELECT user_id FROM channel_team WHERE channel_id = ? AND user_id = ?',
      [inv.channel_id, req.session.user.id]
    );
    if (existing.length > 0) {
      await connection.query("UPDATE pending_team_invites SET status = 'accepted' WHERE id = ?", [inviteId]);
      connection.release();
      return res.json({ success: true });
    }

    try {
      await assertNoTeamRejoinCooldown(connection, inv.channel_id, req.session.user.id);
    } catch (cdErr) {
      await connection.query("UPDATE pending_team_invites SET status = 'cancelled' WHERE id = ?", [inviteId]);
      connection.release();
      return res.status(429).send(cdErr.message || 'Кулдаун на повторное присоединение');
    }

    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO channel_team (channel_id, user_id, is_reporter, is_moderator, is_editor, is_coowner)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [inv.channel_id, req.session.user.id, inv.is_reporter ? 1 : 0, inv.is_moderator ? 1 : 0, inv.is_editor ? 1 : 0, inv.is_coowner ? 1 : 0]
    );
    await connection.query("UPDATE pending_team_invites SET status = 'accepted' WHERE id = ?", [inviteId]);
    await connection.query(
      "UPDATE pending_team_invites SET status = 'cancelled' WHERE channel_id = ? AND invitee_id = ? AND status = 'pending' AND id != ?",
      [inv.channel_id, req.session.user.id, inviteId]
    );
    await connection.commit();
    connection.release();
    return res.json({ success: true });
  } catch (e) {
    console.error('Error accepting team invite:', e);
    return res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,team,invite,reject', requireAuth, async (req, res) => {
  const inviteId = parseInt(req.body.invite_id, 10);
  if (!inviteId) return res.status(400).send('invite_id required');

  try {
    const [result] = await pool.query(
      "UPDATE pending_team_invites SET status = 'rejected' WHERE id = ? AND invitee_id = ? AND status = 'pending'",
      [inviteId, req.session.user.id]
    );
    if (result.affectedRows === 0) return res.status(404).send('Приглашение не найдено');
    return res.json({ success: true });
  } catch (e) {
    console.error('Error rejecting team invite:', e);
    return res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,set_channel', requireAuth, async (req, res) => {
  const { channel_id } = req.body;
  const to = req.query.to || req.body.to;
  if (channel_id) {
    try {
      const connection = await pool.getConnection();
      const [staffRows] = await connection.query('SELECT role FROM staff WHERE user_id = ?', [req.session.user.id]);
      const isStaff = staffRows.length > 0;
      const [owned] = await connection.query(
        "SELECT id FROM channels WHERE id = ? AND user_id = ? AND status IN ('active', 'banned', 'pending_approval', 'rejected_approval')",
        [channel_id, req.session.user.id]
      );
      let allowed = owned.length > 0;
      if (!allowed) {
        const [team] = await connection.query(
          "SELECT c.id FROM channels c JOIN channel_team t ON c.id = t.channel_id WHERE c.id = ? AND t.user_id = ? AND c.status IN ('active', 'banned', 'pending_approval', 'rejected_approval') AND (t.is_editor = 1 OR t.is_reporter = 1 OR t.is_coowner = 1)",
          [channel_id, req.session.user.id]
        );
        allowed = team.length > 0;
      }
      if (!allowed && isStaff) {
        const [staffCh] = await connection.query(
          "SELECT id FROM channels WHERE id = ? AND status IN ('active', 'banned', 'pending_approval', 'rejected_approval')",
          [channel_id]
        );
        allowed = staffCh.length > 0;
      }
      if (!allowed) {
        connection.release();
        return res.status(403).send('Нет доступа к этому каналу');
      }
      // Switching channel ends the temporary-owner session from admin entry
      if (String(channel_id) !== String(req.session.panel_staff_channel_id)) {
        delete req.session.panel_staff_channel_id;
      }
      req.session.panel_channel_id = channel_id;
      if (to === 'channel') {
        const [ch] = await connection.query("SELECT shortname FROM channels WHERE id = ?", [channel_id]);
        connection.release();
        if (ch.length > 0) {
          return res.redirect('/' + ch[0].shortname);
        }
        return res.redirect('/panel,dashboard');
      }
      connection.release();
    } catch (err) {
      console.error(err);
      return res.status(500).send('Server Error');
    }
  }
  res.redirect('/panel,dashboard');
});

module.exports = router;
