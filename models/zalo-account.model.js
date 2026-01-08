// models/zalo-account.model.js
import mongoose from 'mongoose';
const { Schema, model } = mongoose;

/**
 * ZALO ACCOUNT MODEL — Lưu & duy trì trạng thái đăng nhập zca-js
 */

/* ================================ Sub-schemas ================================ */

const ZaloProfileSchema = new Schema(
  {
    zaloId: { type: String, required: true, trim: true },
    displayName: { type: String, default: '', trim: true },
    avatar: { type: String, default: '', trim: true },
    phoneMasked: { type: String, default: '', trim: true },
  },
  { _id: false, strict: true }
);

const DeviceFingerprintSchema = new Schema(
  {
    imei: { type: String, required: true, trim: true },
    userAgent: { type: String, required: true, trim: true },
    deviceName: { type: String, default: 'bot-web', trim: true },
  },
  { _id: false, strict: true }
);

const SessionSchema = new Schema(
  {
    cookies: { type: Schema.Types.Mixed, required: true },
    lastActiveAt: { type: Date, default: Date.now },
    lastLoginAt: { type: Date, default: Date.now },
    lastLoginMethod: { type: String, enum: ['qr', 'cookie'], default: 'qr' },
    sessionVersion: { type: Number, default: 1 },
  },
  { _id: false, strict: true }
);

/* ================================ Main schema ================================ */

const ZaloAccountSchema = new Schema(
  {
    accountKey: { type: String, required: true, unique: true, trim: true },
    profile: { type: ZaloProfileSchema, required: true },
    device: { type: DeviceFingerprintSchema, required: true },
    status: {
      type: String,
      enum: ['active', 'disconnected', 'blocked'],
      default: 'active',
      index: true,
    },
    session: { type: SessionSchema, required: true },
    ops: {
      isLockedForLogin: { type: Boolean, default: false },
      lockedAt: { type: Date, default: null },
      lockedBy: { type: String, default: null, trim: true },
      notes: { type: String, default: '', trim: true },
    },
    ownerId: { type: Schema.Types.ObjectId, ref: 'account', default: null },
    workspaceId: { type: Schema.Types.ObjectId, ref: 'workspace', default: null },
  },
  {
    timestamps: true,
    strict: true,
  }
);

ZaloAccountSchema.index({ accountKey: 1 }, { unique: true });
ZaloAccountSchema.index({ 'profile.zaloId': 1 });
ZaloAccountSchema.index({ status: 1, updatedAt: -1 });

/* ================================ Methods ================================ */

ZaloAccountSchema.statics.upsertFromLoginResult = async function (loginPayload) {
  const {
    accountKey,
    profile,
    device,
    cookies,
    ownerId = null,
    workspaceId = null,
    loginMethod = 'qr',
  } = loginPayload || {};

  if (!accountKey) throw new Error('accountKey (ownId) is required');
  if (!profile?.zaloId) throw new Error('profile.zaloId is required');
  if (!device?.imei || !device?.userAgent) {
    throw new Error('device.imei and device.userAgent is required');
  }
  if (!cookies) throw new Error('cookies is required');

  const now = new Date();

  const updateDoc = {
    profile: {
      zaloId: profile.zaloId,
      displayName: profile.displayName || '',
      avatar: profile.avatar || '',
      phoneMasked: profile.phoneMasked || '',
    },
    device: {
      imei: device.imei,
      userAgent: device.userAgent,
      deviceName: device.deviceName || 'bot-web',
    },
    session: {
      cookies,
      lastActiveAt: now,
      lastLoginAt: now,
      lastLoginMethod: loginMethod,
      sessionVersion: 1,
    },
    status: 'active',
    ownerId,
    workspaceId,
  };

  const doc = await this.findOneAndUpdate(
    { accountKey },
    { $set: updateDoc },
    { new: true, upsert: true }
  );

  return doc;
};

const ZaloAccount = mongoose.models?.zaloaccount || model('zaloaccount', ZaloAccountSchema);

export { ZaloAccount };

