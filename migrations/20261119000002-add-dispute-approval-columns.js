'use strict';

// Two-person approval for large dispute resolutions: the first admin proposes, a different admin approves.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Disputes', 'proposedResolution', { type: Sequelize.JSONB, allowNull: true });
    await queryInterface.addColumn('Disputes', 'proposedByAdminId', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'Admins', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await queryInterface.addColumn('Disputes', 'proposedAt', { type: Sequelize.DATE, allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Disputes', 'proposedAt');
    await queryInterface.removeColumn('Disputes', 'proposedByAdminId');
    await queryInterface.removeColumn('Disputes', 'proposedResolution');
  },
};
