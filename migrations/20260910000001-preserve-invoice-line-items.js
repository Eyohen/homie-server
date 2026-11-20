'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // The legacy Invoices table was originally created via sequelize.sync(), not a migration.
    // On a fresh database it does not exist, so there is nothing to alter.
    const tables = await queryInterface.showAllTables();
    const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName));
    if (!names.includes('Invoices')) {
      console.log('Invoices table not found - skipping legacy invoice line-item migration');
      return;
    }

    await queryInterface.addColumn('Invoices', 'lineItems', { type: Sequelize.JSONB, allowNull: true });
    await queryInterface.addColumn('Invoices', 'taxRate', {
      type: Sequelize.DECIMAL(7, 4), allowNull: false, defaultValue: 0,
    });
    await queryInterface.addColumn('Receipts', 'sourceInvoiceId', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'Invoices', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await queryInterface.addIndex('Receipts', ['sourceInvoiceId'], { unique: true });
  },

  async down(queryInterface) {
    const tables = await queryInterface.showAllTables();
    const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName));
    if (!names.includes('Invoices')) return;

    await queryInterface.removeIndex('Receipts', ['sourceInvoiceId']);
    await queryInterface.removeColumn('Receipts', 'sourceInvoiceId');
    await queryInterface.removeColumn('Invoices', 'taxRate');
    await queryInterface.removeColumn('Invoices', 'lineItems');
  },
};
