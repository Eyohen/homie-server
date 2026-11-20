'use strict';

module.exports = (sequelize, DataTypes) => {
  const ChatThread = sequelize.define('ChatThread', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    hirerId: { type: DataTypes.UUID, allowNull: false, references: { model: 'Members', key: 'id' } },
    chefId: { type: DataTypes.UUID, allowNull: false, references: { model: 'ChefProfiles', key: 'id' } },
    lastMessageText: { type: DataTypes.STRING(300), allowNull: true },
    lastMessageAt: { type: DataTypes.DATE, allowNull: true },
  }, { tableName: 'ChatThreads', timestamps: true });

  ChatThread.associate = (models) => {
    ChatThread.belongsTo(models.Member, { foreignKey: 'hirerId', as: 'hirer' });
    ChatThread.belongsTo(models.ChefProfile, { foreignKey: 'chefId', as: 'chef' });
    ChatThread.hasMany(models.ChatMessage, { foreignKey: 'threadId', as: 'messages' });
  };

  return ChatThread;
};
