'use strict';

// Homie marketplace schema: members (hirers + chefs), chef profiles/services, bookings,
// escrow payments, disputes, chat, reviews, favorites and in-app notifications.

const uuid = (Sequelize) => ({
  type: Sequelize.UUID,
  defaultValue: Sequelize.UUIDV4,
  primaryKey: true,
  allowNull: false,
});

const fk = (Sequelize, model, { allowNull = false, onDelete = 'CASCADE' } = {}) => ({
  type: Sequelize.UUID,
  allowNull,
  references: { model, key: 'id' },
  onUpdate: 'CASCADE',
  onDelete,
});

const stamps = (Sequelize) => ({
  createdAt: { type: Sequelize.DATE, allowNull: false },
  updatedAt: { type: Sequelize.DATE, allowNull: false },
});

const ENUM_TYPES = [
  'enum_Members_activeRole',
  'enum_Members_status',
  'enum_OtpCodes_channel',
  'enum_ChefProfiles_verificationStatus',
  'enum_ChefServices_unit',
  'enum_Bookings_status',
  'enum_BookingPayments_status',
  'enum_BookingPayments_payoutStatus',
  'enum_Disputes_status',
  'enum_Disputes_resolution',
];

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('Members', {
      id: uuid(Sequelize),
      phone: { type: Sequelize.STRING(30), allowNull: true, unique: true },
      email: { type: Sequelize.STRING(255), allowNull: true, unique: true },
      firstName: { type: Sequelize.STRING(100), allowNull: true },
      lastName: { type: Sequelize.STRING(100), allowNull: true },
      avatarUrl: { type: Sequelize.STRING(500), allowNull: true },
      activeRole: { type: Sequelize.ENUM('hirer', 'chef'), allowNull: false, defaultValue: 'hirer' },
      isChef: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      status: { type: Sequelize.ENUM('active', 'suspended', 'deleted'), allowNull: false, defaultValue: 'active' },
      suspendedReason: { type: Sequelize.TEXT, allowNull: true },
      address: { type: Sequelize.TEXT, allowNull: true },
      lat: { type: Sequelize.DECIMAL(9, 6), allowNull: true },
      lng: { type: Sequelize.DECIMAL(9, 6), allowNull: true },
      pushToken: { type: Sequelize.STRING(255), allowNull: true },
      refreshTokenHash: { type: Sequelize.STRING(120), allowNull: true },
      lastLoginAt: { type: Sequelize.DATE, allowNull: true },
      ...stamps(Sequelize),
    });
    await queryInterface.addIndex('Members', ['status']);

    await queryInterface.createTable('OtpCodes', {
      id: uuid(Sequelize),
      target: { type: Sequelize.STRING(255), allowNull: false },
      channel: { type: Sequelize.ENUM('sms', 'email'), allowNull: false },
      codeHash: { type: Sequelize.STRING(120), allowNull: false },
      attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      expiresAt: { type: Sequelize.DATE, allowNull: false },
      consumedAt: { type: Sequelize.DATE, allowNull: true },
      ...stamps(Sequelize),
    });
    await queryInterface.addIndex('OtpCodes', ['target', 'createdAt']);

    await queryInterface.createTable('ChefProfiles', {
      id: uuid(Sequelize),
      memberId: { ...fk(Sequelize, 'Members'), unique: true },
      displayName: { type: Sequelize.STRING(150), allowNull: false },
      bio: { type: Sequelize.TEXT, allowNull: true },
      cuisines: { type: Sequelize.ARRAY(Sequelize.STRING), allowNull: false, defaultValue: [] },
      tags: { type: Sequelize.ARRAY(Sequelize.STRING), allowNull: false, defaultValue: [] },
      yearsExperience: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      eventsCooked: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      replyTime: { type: Sequelize.STRING(30), allowNull: true },
      area: { type: Sequelize.STRING(150), allowNull: true },
      lat: { type: Sequelize.DECIMAL(9, 6), allowNull: true },
      lng: { type: Sequelize.DECIMAL(9, 6), allowNull: true },
      coverUrl: { type: Sequelize.STRING(500), allowNull: true },
      portfolio: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      verificationStatus: {
        type: Sequelize.ENUM('unsubmitted', 'pending', 'verified', 'rejected'),
        allowNull: false,
        defaultValue: 'unsubmitted',
      },
      verificationData: { type: Sequelize.JSONB, allowNull: true },
      verificationNote: { type: Sequelize.TEXT, allowNull: true },
      verifiedAt: { type: Sequelize.DATE, allowNull: true },
      available: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      ratingAvg: { type: Sequelize.DECIMAL(3, 2), allowNull: false, defaultValue: 0 },
      ratingCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      startingPrice: { type: Sequelize.DECIMAL(15, 2), allowNull: true },
      startingUnit: { type: Sequelize.STRING(20), allowNull: true },
      ...stamps(Sequelize),
    });
    await queryInterface.addIndex('ChefProfiles', ['verificationStatus']);
    await queryInterface.addIndex('ChefProfiles', ['available']);

    await queryInterface.createTable('ChefServices', {
      id: uuid(Sequelize),
      chefId: fk(Sequelize, 'ChefProfiles'),
      title: { type: Sequelize.STRING(150), allowNull: false },
      description: { type: Sequelize.TEXT, allowNull: true },
      price: { type: Sequelize.DECIMAL(15, 2), allowNull: false },
      unit: { type: Sequelize.ENUM('dish', 'event', 'hour', 'order'), allowNull: false, defaultValue: 'event' },
      icon: { type: Sequelize.STRING(40), allowNull: true },
      active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      sortOrder: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      ...stamps(Sequelize),
    });
    await queryInterface.addIndex('ChefServices', ['chefId']);

    await queryInterface.createTable('ChefBlockedDates', {
      id: uuid(Sequelize),
      chefId: fk(Sequelize, 'ChefProfiles'),
      date: { type: Sequelize.DATEONLY, allowNull: false },
      reason: { type: Sequelize.STRING(200), allowNull: true },
      ...stamps(Sequelize),
    });
    await queryInterface.addIndex('ChefBlockedDates', ['chefId', 'date'], { unique: true });

    await queryInterface.createTable('PayoutAccounts', {
      id: uuid(Sequelize),
      chefId: { ...fk(Sequelize, 'ChefProfiles'), unique: true },
      bankCode: { type: Sequelize.STRING(20), allowNull: false },
      bankName: { type: Sequelize.STRING(120), allowNull: true },
      accountNumber: { type: Sequelize.STRING(20), allowNull: false },
      accountName: { type: Sequelize.STRING(150), allowNull: true },
      recipientCode: { type: Sequelize.STRING(100), allowNull: true },
      ...stamps(Sequelize),
    });

    await queryInterface.createTable('Bookings', {
      id: uuid(Sequelize),
      reference: { type: Sequelize.STRING(20), allowNull: false, unique: true },
      hirerId: fk(Sequelize, 'Members', { onDelete: 'RESTRICT' }),
      chefId: fk(Sequelize, 'ChefProfiles', { onDelete: 'RESTRICT' }),
      serviceId: fk(Sequelize, 'ChefServices', { allowNull: true, onDelete: 'SET NULL' }),
      serviceTitle: { type: Sequelize.STRING(150), allowNull: false },
      serviceUnit: { type: Sequelize.STRING(20), allowNull: false },
      unitPrice: { type: Sequelize.DECIMAL(15, 2), allowNull: false },
      quantity: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      scheduledAt: { type: Sequelize.DATE, allowNull: false },
      guests: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      address: { type: Sequelize.TEXT, allowNull: false },
      notes: { type: Sequelize.TEXT, allowNull: true },
      chefFee: { type: Sequelize.DECIMAL(15, 2), allowNull: false },
      groceries: { type: Sequelize.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
      total: { type: Sequelize.DECIMAL(15, 2), allowNull: false },
      commissionRate: { type: Sequelize.DECIMAL(5, 4), allowNull: false },
      commission: { type: Sequelize.DECIMAL(15, 2), allowNull: false },
      chefPayout: { type: Sequelize.DECIMAL(15, 2), allowNull: false },
      status: {
        type: Sequelize.ENUM(
          'awaiting_payment', 'pending_chef', 'confirmed', 'in_progress', 'awaiting_approval',
          'completed', 'cancelled', 'declined', 'disputed', 'expired'
        ),
        allowNull: false,
        defaultValue: 'awaiting_payment',
      },
      paidAt: { type: Sequelize.DATE, allowNull: true },
      acceptedAt: { type: Sequelize.DATE, allowNull: true },
      startedAt: { type: Sequelize.DATE, allowNull: true },
      completedAt: { type: Sequelize.DATE, allowNull: true },
      approvedAt: { type: Sequelize.DATE, allowNull: true },
      releasedAt: { type: Sequelize.DATE, allowNull: true },
      cancelledAt: { type: Sequelize.DATE, allowNull: true },
      cancelReason: { type: Sequelize.TEXT, allowNull: true },
      autoReleaseAt: { type: Sequelize.DATE, allowNull: true },
      ...stamps(Sequelize),
    });
    await queryInterface.addIndex('Bookings', ['hirerId']);
    await queryInterface.addIndex('Bookings', ['chefId']);
    await queryInterface.addIndex('Bookings', ['status']);
    await queryInterface.addIndex('Bookings', ['scheduledAt']);

    await queryInterface.createTable('BookingPayments', {
      id: uuid(Sequelize),
      bookingId: fk(Sequelize, 'Bookings', { onDelete: 'RESTRICT' }),
      paystackReference: { type: Sequelize.STRING(100), allowNull: false, unique: true },
      accessCode: { type: Sequelize.STRING(100), allowNull: true },
      authorizationUrl: { type: Sequelize.STRING(500), allowNull: true },
      amount: { type: Sequelize.DECIMAL(15, 2), allowNull: false },
      currency: { type: Sequelize.STRING(5), allowNull: false, defaultValue: 'NGN' },
      channel: { type: Sequelize.STRING(30), allowNull: true },
      status: {
        type: Sequelize.ENUM('initialized', 'held', 'released', 'refund_pending', 'refunded', 'partially_refunded', 'failed'),
        allowNull: false,
        defaultValue: 'initialized',
      },
      paidAt: { type: Sequelize.DATE, allowNull: true },
      releasedAt: { type: Sequelize.DATE, allowNull: true },
      refundedAt: { type: Sequelize.DATE, allowNull: true },
      refundAmount: { type: Sequelize.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
      payoutStatus: {
        type: Sequelize.ENUM('none', 'pending', 'processing', 'paid', 'failed'),
        allowNull: false,
        defaultValue: 'none',
      },
      payoutAmount: { type: Sequelize.DECIMAL(15, 2), allowNull: true },
      payoutReference: { type: Sequelize.STRING(100), allowNull: true },
      payoutError: { type: Sequelize.TEXT, allowNull: true },
      gatewayResponse: { type: Sequelize.JSONB, allowNull: true },
      ...stamps(Sequelize),
    });
    await queryInterface.addIndex('BookingPayments', ['bookingId']);
    await queryInterface.addIndex('BookingPayments', ['status']);
    await queryInterface.addIndex('BookingPayments', ['payoutStatus']);

    await queryInterface.createTable('Disputes', {
      id: uuid(Sequelize),
      bookingId: fk(Sequelize, 'Bookings', { onDelete: 'RESTRICT' }),
      openedById: fk(Sequelize, 'Members', { onDelete: 'RESTRICT' }),
      reason: { type: Sequelize.TEXT, allowNull: false },
      status: { type: Sequelize.ENUM('open', 'under_review', 'resolved'), allowNull: false, defaultValue: 'open' },
      resolution: { type: Sequelize.ENUM('release', 'refund', 'split'), allowNull: true },
      splitPercentToChef: { type: Sequelize.INTEGER, allowNull: true },
      resolutionNote: { type: Sequelize.TEXT, allowNull: true },
      resolvedByAdminId: fk(Sequelize, 'Admins', { allowNull: true, onDelete: 'SET NULL' }),
      resolvedAt: { type: Sequelize.DATE, allowNull: true },
      ...stamps(Sequelize),
    });
    await queryInterface.addIndex('Disputes', ['status']);
    await queryInterface.addIndex('Disputes', ['bookingId']);

    await queryInterface.createTable('ChatThreads', {
      id: uuid(Sequelize),
      hirerId: fk(Sequelize, 'Members'),
      chefId: fk(Sequelize, 'ChefProfiles'),
      lastMessageText: { type: Sequelize.STRING(300), allowNull: true },
      lastMessageAt: { type: Sequelize.DATE, allowNull: true },
      ...stamps(Sequelize),
    });
    await queryInterface.addIndex('ChatThreads', ['hirerId', 'chefId'], { unique: true });
    await queryInterface.addIndex('ChatThreads', ['chefId']);

    await queryInterface.createTable('ChatMessages', {
      id: uuid(Sequelize),
      threadId: fk(Sequelize, 'ChatThreads'),
      senderId: fk(Sequelize, 'Members'),
      body: { type: Sequelize.TEXT, allowNull: false },
      flagged: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      flagReason: { type: Sequelize.STRING(120), allowNull: true },
      reviewedAt: { type: Sequelize.DATE, allowNull: true },
      readAt: { type: Sequelize.DATE, allowNull: true },
      ...stamps(Sequelize),
    });
    await queryInterface.addIndex('ChatMessages', ['threadId', 'createdAt']);
    await queryInterface.addIndex('ChatMessages', ['flagged']);

    await queryInterface.createTable('BookingReviews', {
      id: uuid(Sequelize),
      bookingId: { ...fk(Sequelize, 'Bookings'), unique: true },
      hirerId: fk(Sequelize, 'Members'),
      chefId: fk(Sequelize, 'ChefProfiles'),
      rating: { type: Sequelize.INTEGER, allowNull: false },
      comment: { type: Sequelize.TEXT, allowNull: true },
      ...stamps(Sequelize),
    });
    await queryInterface.addIndex('BookingReviews', ['chefId', 'createdAt']);

    await queryInterface.createTable('Favorites', {
      id: uuid(Sequelize),
      memberId: fk(Sequelize, 'Members'),
      chefId: fk(Sequelize, 'ChefProfiles'),
      ...stamps(Sequelize),
    });
    await queryInterface.addIndex('Favorites', ['memberId', 'chefId'], { unique: true });

    await queryInterface.createTable('AppNotifications', {
      id: uuid(Sequelize),
      memberId: fk(Sequelize, 'Members'),
      type: { type: Sequelize.STRING(40), allowNull: false },
      title: { type: Sequelize.STRING(160), allowNull: false },
      body: { type: Sequelize.TEXT, allowNull: true },
      data: { type: Sequelize.JSONB, allowNull: true },
      readAt: { type: Sequelize.DATE, allowNull: true },
      ...stamps(Sequelize),
    });
    await queryInterface.addIndex('AppNotifications', ['memberId', 'createdAt']);
  },

  async down(queryInterface) {
    const tables = [
      'AppNotifications', 'Favorites', 'BookingReviews', 'ChatMessages', 'ChatThreads', 'Disputes',
      'BookingPayments', 'Bookings', 'PayoutAccounts', 'ChefBlockedDates', 'ChefServices',
      'ChefProfiles', 'OtpCodes', 'Members',
    ];
    for (const table of tables) {
      await queryInterface.dropTable(table);
    }
    for (const type of ENUM_TYPES) {
      await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "${type}";`);
    }
  },
};
