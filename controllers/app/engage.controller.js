// Favorites, notifications and uploads: small member-facing features.
const { Op } = require('sequelize');
const db = require('../../models');
const cloudinaryService = require('../../services/cloudinary.service');
const { chefSummary } = require('../../utils/homieSerializers');

const { Favorite, ChefProfile, Member, AppNotification } = db;

exports.listFavorites = async (req, res) => {
  const favorites = await Favorite.findAll({
    where: { memberId: req.member.id },
    include: [{ model: ChefProfile, as: 'chef', include: [{ model: Member, as: 'member', attributes: ['avatarUrl', 'status'] }] }],
    order: [['createdAt', 'DESC']],
  });
  const chefs = favorites.filter((f) => f.chef && f.chef.verificationStatus === 'verified').map((f) => chefSummary(f.chef, { isFavorite: true }));
  return res.json({ success: true, data: { chefs } });
};

exports.addFavorite = async (req, res) => {
  const chef = await ChefProfile.findByPk(req.params.chefId, { attributes: ['id'] });
  if (!chef) return res.status(404).json({ success: false, message: 'Chef not found' });
  await Favorite.findOrCreate({ where: { memberId: req.member.id, chefId: chef.id }, defaults: { memberId: req.member.id, chefId: chef.id } });
  return res.json({ success: true, data: { isFavorite: true } });
};

exports.removeFavorite = async (req, res) => {
  await Favorite.destroy({ where: { memberId: req.member.id, chefId: req.params.chefId } });
  return res.json({ success: true, data: { isFavorite: false } });
};

exports.listNotifications = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const [{ rows, count }, unread] = await Promise.all([
    AppNotification.findAndCountAll({ where: { memberId: req.member.id }, order: [['createdAt', 'DESC']], limit, offset: (page - 1) * limit }),
    AppNotification.count({ where: { memberId: req.member.id, readAt: null } }),
  ]);
  return res.json({
    success: true,
    data: {
      notifications: rows.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, data: n.data, read: !!n.readAt, createdAt: n.createdAt })),
      unreadCount: unread,
      pagination: { page, limit, total: count, pages: Math.ceil(count / limit) },
    },
  });
};

exports.markRead = async (req, res) => {
  const where = { memberId: req.member.id, readAt: null };
  if (req.params.id) where.id = req.params.id;
  await AppNotification.update({ readAt: new Date() }, { where });
  return res.json({ success: true });
};

// POST /api/app/uploads?kind=avatar|portfolio|verification  (multipart field "file")
exports.uploadImage = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const kind = ['avatar', 'portfolio', 'verification'].includes(req.query.kind) ? req.query.kind : 'portfolio';
    const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const result = kind === 'avatar'
      ? await cloudinaryService.uploadAvatar(dataUri)
      : await cloudinaryService.uploadImage(dataUri, { folder: `homie/${kind}` });
    return res.json({ success: true, data: { url: result.secure_url, publicId: result.public_id } });
  } catch (error) {
    console.error('upload error:', error);
    return res.status(500).json({ success: false, message: 'Upload failed' });
  }
};
