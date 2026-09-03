-- CreateTable
CREATE TABLE "spike_tenant" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "spike_tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spike_row" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "secret" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spike_row_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "spike_row_tenant_id_idx" ON "spike_row"("tenant_id");

-- AddForeignKey
ALTER TABLE "spike_row" ADD CONSTRAINT "spike_row_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "spike_tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
