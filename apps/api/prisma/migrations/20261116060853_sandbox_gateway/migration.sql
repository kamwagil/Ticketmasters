-- CreateTable
CREATE TABLE "sandbox_gateway_transactions" (
    "reference" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "providerAccountId" UUID NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "callbackUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "refundedMinor" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandbox_gateway_transactions_pkey" PRIMARY KEY ("reference")
);

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_gateway_transactions_transactionId_key" ON "sandbox_gateway_transactions"("transactionId");
