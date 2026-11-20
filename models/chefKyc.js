'use strict';

module.exports = (sequelize, DataTypes) => {
  const ChefKyc = sequelize.define('ChefKyc', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    chefId: { type: DataTypes.UUID, allowNull: false, unique: true, references: { model: 'ChefProfiles', key: 'id' } },
    dateOfBirth: { type: DataTypes.DATEONLY, allowNull: true },
    residentialAddress: { type: DataTypes.TEXT, allowNull: true },
    idType: { type: DataTypes.STRING(30), allowNull: true },
    idLast4: { type: DataTypes.STRING(4), allowNull: true },
    // Private document references (Cloudinary public ids), never public URLs:
    // { idDocument, photo, cv, foodSafety, qualifications: [{ name, ref }] }
    documents: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    references: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    backgroundCheck: { type: DataTypes.JSONB, allowNull: false, defaultValue: { status: 'not_started' } },
    practicalAssessment: { type: DataTypes.JSONB, allowNull: false, defaultValue: { status: 'not_started' } },
    agreement: { type: DataTypes.JSONB, allowNull: true },
    // Per-item admin review: { idDocument: { status, note, reviewedAt, reviewedBy }, ... }
    checklist: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    submittedAt: { type: DataTypes.DATE, allowNull: true },
    reviewedAt: { type: DataTypes.DATE, allowNull: true },
    reviewNote: { type: DataTypes.TEXT, allowNull: true },
  }, { tableName: 'ChefKycs', timestamps: true });

  ChefKyc.associate = (models) => {
    ChefKyc.belongsTo(models.ChefProfile, { foreignKey: 'chefId', as: 'chef' });
  };

  return ChefKyc;
};
