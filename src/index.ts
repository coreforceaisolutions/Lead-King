{
  "name": "lead-kings-backend",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "ts-node-dev --respawn --transpile-only src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate dev --name init"
  },
  "dependencies": {
    "@prisma/client": "^5.0.0",
    "body-parser": "^1.20.2",
    "cors": "^2.8.5",
    "dotenv": "^16.0.3",
    "express": "^4.18.2",
    "qrcode": "^1.5.1"
  },
  "devDependencies": {
    "prisma": "^5.0.0",
    "ts-node-dev": "^2.0.0",
    "typescript": "^5.4.2"
  }
}generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id         String   @id @default(uuid())
  name       String
  email      String   @unique
  phone      String?
  password   String
  createdAt  DateTime @default(now())
  companies  Company[]
  subscriptions Subscription[]
  transactions Transaction[]
}

model Company {
  id        String   @id @default(uuid())
  name      String
  website   String?
  industry  String?
  size      String?
  address   String?
  ownerId   String
  owner     User     @relation(fields: [ownerId], references: [id])
  createdAt DateTime @default(now())
}

model Plan {
  id           String   @id @default(uuid())
  name         String
  priceCents   Int
  currency     String   @default("INR")
  leadsPerDay  Int
  createdAt    DateTime @default(now())
  subscriptions Subscription[]
}

model Subscription {
  id                    String   @id @default(uuid())
  userId                String
  planId                String
  providerSubscriptionId String?
  status                String
  startedAt             DateTime?
  endsAt                DateTime?
  createdAt             DateTime @default(now())
  user                  User     @relation(fields: [userId], references: [id])
  plan                  Plan     @relation(fields: [planId], references: [id])
}

model Transaction {
  id              String   @id @default(uuid())
  userId          String
  provider        String
  providerEntityId String?
  status          String
  amountCents     Int
  currency        String   @default("INR")
  rawResponse     Json?
  createdAt       DateTime @default(now())
  user            User     @relation(fields: [userId], references: [id])
}# Database
DATABASE_URL="postgresql://user:password@localhost:5432/leadkings?schema=public"

# GPay / UPI
GPAY_UPI_ID=merchant@upi
GPAY_PAYEE_NAME="Lead Kings"

# App
PORT=4000import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export default prisma;import QRCode from 'qrcode';
import dotenv from 'dotenv';
dotenv.config();

export function createUpiDeepLink(amountCents: number, upiId?: string, payeeName?: string, txnId?: string) {
  const pa = encodeURIComponent(upiId || process.env.GPAY_UPI_ID || '');
  const pn = encodeURIComponent(payeeName || process.env.GPAY_PAYEE_NAME || '');
  const am = (amountCents / 100).toFixed(2);
  const cu = 'INR';
  const tn = txnId ? encodeURIComponent(String(txnId)) : '';

  const params = new URLSearchParams();
  if (pa) params.set('pa', pa);
  if (pn) params.set('pn', pn);
  if (am) params.set('am', am);
  params.set('cu', cu);
  if (tn) params.set('tn', tn);

  const upiLink = `upi://pay?${params.toString()}`;
  return upiLink;
}

export async function generateUpiQrDataUrl(upiLink: string) {
  const dataUrl = await QRCode.toDataURL(upiLink, { type: 'image/png' });
  return dataUrl;
}import { Request, Response } from 'express';
import prisma from '../db/prismaClient';
import { createUpiDeepLink, generateUpiQrDataUrl } from '../services/gpay';
import dotenv from 'dotenv';
dotenv.config();

export async function initiateGpayPayment(req: Request, res: Response) {
  const { userId, amountCents, upiId, payeeName, planId } = req.body;
  if (!userId || !amountCents) return res.status(400).json({ error: 'userId and amountCents are required' });

  const transaction = await prisma.transaction.create({
    data: {
      userId,
      provider: 'gpay',
      status: 'pending',
      amountCents,
      currency: 'INR',
      rawResponse: { planId: planId || null }
    }
  });

  try {
    const upiLink = createUpiDeepLink(amountCents, upiId, payeeName, transaction.id);
    const qrDataUrl = await generateUpiQrDataUrl(upiLink);

    return res.json({
      transactionId: transaction.id,
      upiLink,
      qrDataUrl,
      amountCents,
      currency: transaction.currency
    });
  } catch (err) {
    console.error('initiateGpayPayment error', err);
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: { status: 'failed', rawResponse: { error: String(err) } }
    });
    return res.status(500).json({ error: 'failed to create UPI link' });
  }
}

export async function confirmGpayPayment(req: Request, res: Response) {
  const { transactionId, providerEntityId, status, rawResponse } = req.body;
  if (!transactionId || !status) return res.status(400).json({ error: 'transactionId and status are required' });

  const tx = await prisma.transaction.findUnique({ where: { id: transactionId } });
  if (!tx) return res.status(404).json({ error: 'transaction not found' });

  try {
    await prisma.transaction.update({
      where: { id: transactionId },
      data: {
        status,
        providerEntityId: providerEntityId || tx.providerEntityId,
        rawResponse: rawResponse || tx.rawResponse
      }
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('confirmGpayPayment error', err);
    return res.status(500).json({ error: 'failed to update transaction' });
  }
}import { Router } from 'express';
import { initiateGpayPayment, confirmGpayPayment } from './controllers/payments';
import bodyParser from 'body-parser';

const router = Router();

router.use(bodyParser.json());

router.post('/api/payments/gpay/initiate', initiateGpayPayment);
router.post('/api/payments/gpay/confirm', confirmGpayPayment);

export default router;import express from 'express';
import dotenv from 'dotenv';
import router from './routes';
import bodyParser from 'body-parser';
import cors from 'cors';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 4000);

app.use(cors());
app.use(bodyParser.json());
app.use(router);

app.listen(port, () => {
  console.log(`Lead Kings backend listening on http://localhost:${port}`);
});# Lead Kings — GPay/UPI integration scaffold

What this does
- Provides endpoints to create a UPI deep link and QR code for GPay/UPI payments and a confirm endpoint to mark transactions succeeded/failed.
- Uses Prisma for DB schema (Postgres).
- Example flow (without a PSP):
  1. Frontend calls /api/payments/gpay/initiate -> Server creates a pending transaction and returns UPI deep link + QR image data URL.
  2. User opens the UPI deep link or scans the QR in Google Pay -> user pays.
  3. Since native GPay does not send server webhooks, you must reconcile payments either:
     - Manually via /api/payments/gpay/confirm (admin or support marks transaction succeeded and adds provider reference),
     - Or integrate a Payment Service Provider (PSP) that supports UPI collect and can send server webhooks; then adapt the confirm endpoint to accept PSP webhooks and verify signatures.

Local setup
1. Copy .env.example to .env and fill values:
   - DATABASE_URL
   - GPAY_UPI_ID (optional; can be passed per-request)
   - GPAY_PAYEE_NAME

2. Install deps:
   npm install

3. Prisma:
   npx prisma generate
   npx prisma migrate dev --name init

4. Run dev server:
   npm run dev

Frontend example (call initiate and open GPay)
```html
<img id="qr" />
<script>
async function startGpay(userId, amountCents, upiId, payeeName) {
  const resp = await fetch('/api/payments/gpay/initiate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, amountCents, upiId, payeeName })
  });
  const data = await resp.json();
  if (data.error) return alert('failed to create UPI payment: ' + data.error);

  // Display QR
  document.getElementById('qr').src = data.qrDataUrl;

  // Or open the UPI deep link to open Google Pay:
  // window.location.href = data.upiLink;
  // Note: use client-side UX to confirm and show instructions.
}
</script>
```

Notes & security
- UPI deep link approach opens the user's UPI app (GPay) to perform payment; there is no guaranteed server-side confirmation unless you use a PSP that provides webhooks or bank/UPI reconciliation APIs.
- For production, integrate a PSP (Razorpay, Cashfree, PayU, etc.) and adapt the confirm endpoint to accept and verify PSP webhooks.
- Store only provider entity IDs and receipts, not user bank details.
- Use HTTPS in production.
