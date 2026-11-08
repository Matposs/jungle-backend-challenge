import { defineEntity } from '@mikro-orm/core';

export const InboxRecord = defineEntity({
  name: 'InboxRecord',
  tableName: 'inbox_messages',
  properties: (p) => ({
    consumerName: p.text().primary(),
    messageId: p.text().primary(),
    payloadHash: p.text(),
    receivedAt: p.datetime().columnType('timestamptz'),
    processedAt: p.datetime().columnType('timestamptz').nullable(),
  }),
});
