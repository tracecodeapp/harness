import 'ses';

// SES's default override plan leaves Object.prototype.constructor and other
// record keys as inherited, non-writable data properties. Use SES's record
// override setters so assignment creates an own property on the receiver.
// Lockdown still freezes the intrinsics and rejects writes to them directly.
lockdown({ overrideTaming: 'severe' });
await import('./ses-algorithm-worker.js');
