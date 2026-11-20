const { Op, literal, where: sqlWhere } = require('sequelize');
const db = require('../../models');
const { chefSummary, serviceView, reviewView, num } = require('../../utils/homieSerializers');
const { unavailableDays } = require('../../services/booking.service');

const { ChefProfile, ChefService, Member, BookingReview, Favorite } = db;

const SORTS = {
  rating: [['ratingAvg', 'DESC'], ['ratingCount', 'DESC']],
  price: [['startingPrice', 'ASC']],
  popular: [['eventsCooked', 'DESC']],
};

const haversine = (lat, lng) => literal(
  `(6371 * acos(LEAST(1, cos(radians(${lat})) * cos(radians("ChefProfile"."lat")) * cos(radians("ChefProfile"."lng") - radians(${lng})) + sin(radians(${lat})) * sin(radians("ChefProfile"."lat")))))`
);

const parseCoord = (v) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

exports.list = async (req, res) => {
  try {
    const { q, cuisine, sort } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const maxDistance = parseCoord(req.query.maxDistance);
    const minRating = parseCoord(req.query.minRating);
    const lat = parseCoord(req.query.lat) ?? num(req.member?.lat);
    const lng = parseCoord(req.query.lng) ?? num(req.member?.lng);
    const hasPoint = lat !== null && lng !== null;

    const and = [{ verificationStatus: 'verified' }];
    if (cuisine && cuisine !== 'All') and.push({ cuisines: { [Op.contains]: [String(cuisine)] } });
    if (minRating) and.push({ ratingAvg: { [Op.gte]: minRating } });
    if (q && String(q).trim()) {
      const term = `%${String(q).trim().replace(/[%_\\]/g, '\\$&')}%`;
      and.push({
        [Op.or]: [
          { displayName: { [Op.iLike]: term } },
          sqlWhere(literal(`array_to_string("ChefProfile"."cuisines", ' ')`), { [Op.iLike]: term }),
          sqlWhere(literal(`array_to_string("ChefProfile"."tags", ' ')`), { [Op.iLike]: term }),
        ],
      });
    }
    if (maxDistance && hasPoint) and.push(sqlWhere(haversine(lat, lng), { [Op.lte]: maxDistance }));

    let order = SORTS[sort] || SORTS.rating;
    if (sort === 'distance' && hasPoint) order = [[haversine(lat, lng), 'ASC']];

    const include = [{ model: Member, as: 'member', attributes: ['avatarUrl'], where: { status: 'active' }, required: true }];
    const { rows, count } = await ChefProfile.findAndCountAll({
      where: { [Op.and]: and },
      attributes: { include: hasPoint ? [[haversine(lat, lng), 'distance']] : [] },
      include,
      order,
      limit,
      offset: (page - 1) * limit,
      distinct: true,
    });

    let favoriteIds = new Set();
    if (req.member && rows.length) {
      const favs = await Favorite.findAll({ where: { memberId: req.member.id, chefId: rows.map((r) => r.id) }, attributes: ['chefId'] });
      favoriteIds = new Set(favs.map((f) => f.chefId));
    }

    return res.json({
      success: true,
      data: {
        chefs: rows.map((c) => chefSummary(c, { distance: c.get('distance'), isFavorite: favoriteIds.has(c.id) })),
        pagination: { page, limit, total: count, pages: Math.ceil(count / limit) },
      },
    });
  } catch (error) {
    console.error('list chefs error:', error);
    return res.status(500).json({ success: false, message: 'Could not load chefs' });
  }
};

exports.detail = async (req, res) => {
  try {
    const chef = await ChefProfile.findByPk(req.params.id, {
      include: [
        { model: Member, as: 'member', attributes: ['id', 'avatarUrl', 'status'] },
        { model: ChefService, as: 'services', where: { active: true }, required: false },
      ],
    });
    const isOwner = req.member && chef && chef.memberId === req.member.id;
    if (!chef || (!isOwner && (chef.verificationStatus !== 'verified' || chef.member.status !== 'active'))) {
      return res.status(404).json({ success: false, message: 'Chef not found' });
    }

    const reviews = await BookingReview.findAll({
      where: { chefId: chef.id },
      include: [{ model: Member, as: 'hirer', attributes: ['firstName', 'lastName'] }],
      order: [['createdAt', 'DESC']],
      limit: 5,
    });
    const from = new Date();
    const to = new Date(Date.now() + 90 * 24 * 3600 * 1000);
    const [unavailable, favorite] = await Promise.all([
      unavailableDays(chef.id, from, to),
      req.member ? Favorite.count({ where: { memberId: req.member.id, chefId: chef.id } }) : 0,
    ]);

    return res.json({
      success: true,
      data: {
        chef: {
          ...chefSummary(chef, { isFavorite: favorite > 0 }),
          bio: chef.bio,
          portfolio: chef.portfolio,
          services: chef.services.sort((a, b) => a.sortOrder - b.sortOrder).map(serviceView),
          reviews: reviews.map(reviewView),
          unavailableDays: unavailable,
        },
      },
    });
  } catch (error) {
    console.error('chef detail error:', error);
    return res.status(500).json({ success: false, message: 'Could not load chef' });
  }
};

exports.reviews = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const { rows, count } = await BookingReview.findAndCountAll({
      where: { chefId: req.params.id },
      include: [{ model: Member, as: 'hirer', attributes: ['firstName', 'lastName'] }],
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
    });
    return res.json({ success: true, data: { reviews: rows.map(reviewView), pagination: { page, limit, total: count, pages: Math.ceil(count / limit) } } });
  } catch (error) {
    console.error('chef reviews error:', error);
    return res.status(500).json({ success: false, message: 'Could not load reviews' });
  }
};

exports.availability = async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : new Date();
    const to = req.query.to ? new Date(req.query.to) : new Date(Date.now() + 90 * 24 * 3600 * 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) {
      return res.status(400).json({ success: false, message: 'Invalid date range' });
    }
    return res.json({ success: true, data: { unavailableDays: await unavailableDays(req.params.id, from, to) } });
  } catch (error) {
    console.error('availability error:', error);
    return res.status(500).json({ success: false, message: 'Could not load availability' });
  }
};
