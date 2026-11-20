'use strict';

module.exports = (sequelize, DataTypes) => {
  const ChatMessage = sequelize.define('ChatMessage', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    threadId: { type: DataTypes.UUID, allowNull: false, references: { model: 'ChatThreads', key: 'id' } },
    senderId: { type: DataTypes.UUID, allowNull: false, references: { model: 'Members', key: 'id' } },
    body: { type: DataTypes.TEXT, allowNull: false },
    flagged: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    flagReason: { type: DataTypes.STRING(120), allowNull: true },
    reviewedAt: { type: DataTypes.DATE, allowNull: true },
    readAt: { type: DataTypes.DATE, allowNull: true },
  }, { tableName: 'ChatMessages', timestamps: true });

  ChatMessage.associate = (models) => {
    ChatMessage.belongsTo(models.ChatThread, { foreignKey: 'threadId', as: 'thread' });
    ChatMessage.belongsTo(models.Member, { foreignKey: 'senderId', as: 'sender' });
  };

  return ChatMessage;
};
