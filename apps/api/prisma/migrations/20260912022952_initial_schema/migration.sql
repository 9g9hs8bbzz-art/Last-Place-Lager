-- CreateEnum
CREATE TYPE "Role" AS ENUM ('MEMBER', 'ADMIN');

-- CreateEnum
CREATE TYPE "WeekStatus" AS ENUM ('IN_PROGRESS', 'ALL_LOCKED', 'ACTION_REQUIRED', 'READY_TO_PLACE', 'TICKET_UPLOADED', 'OFFICIAL', 'LIVE', 'SETTLED', 'WEEK_OFF');

-- CreateEnum
CREATE TYPE "GameStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'FINAL', 'POSTPONED', 'CANCELED');

-- CreateEnum
CREATE TYPE "MarketSource" AS ENUM ('SBM_BOARD_READER', 'ADMIN_MANUAL', 'ADMIN_SCREENSHOT', 'ADMIN_FILE_IMPORT');

-- CreateEnum
CREATE TYPE "ReaderStatus" AS ENUM ('IDLE', 'RUNNING', 'COMPLETED', 'STOPPED_BUDGET', 'STOPPED_RATE_LIMIT', 'STOPPED_ERROR', 'PAUSED_FOR_SAFETY');

-- CreateEnum
CREATE TYPE "PickState" AS ENUM ('PENDING', 'LOCKED', 'RELEASED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('UPLOADED', 'EXTRACTING', 'NEEDS_REVIEW', 'VERIFIED', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "LegVerification" AS ENUM ('MATCH', 'MATCH_ODDS_CHANGED', 'SELECTION_MISMATCH', 'MISSING_FROM_TICKET', 'EXTRA_ON_TICKET', 'ADMIN_RESOLVED');

-- CreateEnum
CREATE TYPE "LegResult" AS ENUM ('PENDING', 'WIN', 'LOSS', 'PUSH', 'VOID');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('PREVIEW', 'APPLIED', 'ROLLED_BACK', 'FAILED');

-- CreateEnum
CREATE TYPE "CorrectionStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REMOVED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "legacyName" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Season" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NFLWeek" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "weekNumber" INTEGER NOT NULL,
    "status" "WeekStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "weekOffReason" TEXT,
    "weekOffSetAt" TIMESTAMP(3),
    "selectionOpensAt" TIMESTAMP(3),
    "selectionClosesAt" TIMESTAMP(3),
    "eligibleWeekdays" INTEGER[] DEFAULT ARRAY[0, 1]::INTEGER[],
    "frozenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NFLWeek_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "abbreviation" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "conference" TEXT,
    "division" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NFLGame" (
    "id" TEXT NOT NULL,
    "nflWeekId" TEXT NOT NULL,
    "providerGameId" TEXT NOT NULL,
    "homeTeamId" TEXT NOT NULL,
    "awayTeamId" TEXT NOT NULL,
    "kickoffAt" TIMESTAMP(3) NOT NULL,
    "status" "GameStatus" NOT NULL DEFAULT 'SCHEDULED',
    "eligible" BOOLEAN NOT NULL DEFAULT true,
    "eligibilityNote" TEXT,
    "venue" TEXT,
    "indoor" BOOLEAN NOT NULL DEFAULT false,
    "homeScore" INTEGER,
    "awayScore" INTEGER,
    "quarter" TEXT,
    "clock" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NFLGame_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SportsbookEvent" (
    "id" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "nflGameId" TEXT,
    "homeTeamName" TEXT NOT NULL,
    "awayTeamName" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "eventStatus" TEXT,
    "sourceUrl" TEXT,
    "etag" TEXT,
    "lastModifiedHttp" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastSuccessfulReadAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SportsbookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Market" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "sourceMarketId" TEXT,
    "category" TEXT NOT NULL,
    "marketKey" TEXT NOT NULL,
    "marketLabel" TEXT NOT NULL,
    "subjectKey" TEXT,
    "subjectLabel" TEXT,
    "selectionKey" TEXT NOT NULL,
    "selectionLabel" TEXT NOT NULL,
    "line" DECIMAL(8,2),
    "selectionIdentity" TEXT NOT NULL,
    "americanOdds" INTEGER,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "source" "MarketSource" NOT NULL DEFAULT 'SBM_BOARD_READER',
    "manualNote" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVerifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unavailableSince" TIMESTAMP(3),
    "unavailableConfirmations" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketSnapshot" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "americanOdds" INTEGER,
    "line" DECIMAL(8,2),
    "available" BOOLEAN NOT NULL,
    "source" "MarketSource" NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readerRunId" TEXT,

    CONSTRAINT "MarketSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReaderRun" (
    "id" TEXT NOT NULL,
    "nflWeekId" TEXT,
    "status" "ReaderStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "progressNote" TEXT,
    "requestsMade" INTEGER NOT NULL DEFAULT 0,
    "requestBudget" INTEGER NOT NULL,
    "eventsChecked" INTEGER NOT NULL DEFAULT 0,
    "marketsActive" INTEGER NOT NULL DEFAULT 0,
    "marketsChanged" INTEGER NOT NULL DEFAULT 0,
    "marketsNew" INTEGER NOT NULL DEFAULT 0,
    "marketsRemoved" INTEGER NOT NULL DEFAULT 0,
    "marketsRestored" INTEGER NOT NULL DEFAULT 0,
    "cacheHits" INTEGER NOT NULL DEFAULT 0,
    "rateLimited" BOOLEAN NOT NULL DEFAULT false,
    "retryAfterSec" INTEGER,
    "errorSummary" TEXT,

    CONSTRAINT "ReaderRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReaderError" (
    "id" TEXT NOT NULL,
    "readerRunId" TEXT,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "url" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReaderError_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReaderCircuitBreaker" (
    "id" TEXT NOT NULL,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMP(3),
    "cooldownUntil" TIMESTAMP(3),
    "reason" TEXT,
    "lastSuccessAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReaderCircuitBreaker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchedPick" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nflWeekId" TEXT NOT NULL,
    "nflGameId" TEXT,
    "marketId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchedPick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pick" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nflWeekId" TEXT NOT NULL,
    "nflGameId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "state" "PickState" NOT NULL DEFAULT 'PENDING',
    "lockedAt" TIMESTAMP(3),
    "lockedAmericanOdds" INTEGER,
    "lockedLine" DECIMAL(8,2),
    "lockedSelectionText" TEXT,
    "lockedMarketSourceId" TEXT,
    "lockedSource" "MarketSource",
    "marketUnavailableAt" TIMESTAMP(3),
    "unavailableAckAt" TIMESTAMP(3),
    "outsideGuidelineAtLock" BOOLEAN NOT NULL DEFAULT false,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PickChange" (
    "id" TEXT NOT NULL,
    "pickId" TEXT NOT NULL,
    "changeKind" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PickChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchupReservation" (
    "id" TEXT NOT NULL,
    "nflWeekId" TEXT NOT NULL,
    "nflGameId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pickId" TEXT,
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchupReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfficialTicket" (
    "id" TEXT NOT NULL,
    "nflWeekId" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'UPLOADED',
    "imagePath" TEXT NOT NULL,
    "imageMimeType" TEXT,
    "uploadedById" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ticketReference" TEXT,
    "ticketPlacedAt" TIMESTAMP(3),
    "combinedAmericanOdds" INTEGER,
    "wagerAmount" DECIMAL(10,2),
    "potentialPayout" DECIMAL(12,2),
    "ocrProvider" TEXT,
    "ocrConfidence" DOUBLE PRECISION,
    "ocrRawText" TEXT,
    "extractionNotes" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,

    CONSTRAINT "OfficialTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfficialTicketLeg" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "userId" TEXT,
    "pickId" TEXT,
    "legIndex" INTEGER NOT NULL,
    "descriptionText" TEXT NOT NULL,
    "marketKey" TEXT,
    "subjectLabel" TEXT,
    "selectionLabel" TEXT,
    "line" DECIMAL(8,2),
    "americanOdds" INTEGER,
    "verification" "LegVerification" NOT NULL DEFAULT 'MATCH',
    "verificationNote" TEXT,
    "result" "LegResult" NOT NULL DEFAULT 'PENDING',
    "actualValue" DECIMAL(10,2),
    "margin" DECIMAL(10,2),
    "resultNarrative" TEXT,
    "gradedAt" TIMESTAMP(3),
    "gradedManually" BOOLEAN NOT NULL DEFAULT false,
    "awaitingManualGrading" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "OfficialTicketLeg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResultAudit" (
    "id" TEXT NOT NULL,
    "legId" TEXT NOT NULL,
    "actorId" TEXT,
    "fromResult" "LegResult",
    "toResult" "LegResult" NOT NULL,
    "reason" TEXT,
    "automatic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResultAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Parlay" (
    "id" TEXT NOT NULL,
    "nflWeekId" TEXT NOT NULL,
    "combinedAmericanOdds" INTEGER,
    "wagerAmount" DECIMAL(10,2),
    "potentialPayout" DECIMAL(12,2),
    "legsWon" INTEGER NOT NULL DEFAULT 0,
    "legsLost" INTEGER NOT NULL DEFAULT 0,
    "legsPush" INTEGER NOT NULL DEFAULT 0,
    "settled" BOOLEAN NOT NULL DEFAULT false,
    "won" BOOLEAN,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "Parlay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchArticle" (
    "id" TEXT NOT NULL,
    "marketId" TEXT,
    "nflGameId" TEXT,
    "subjectKey" TEXT,
    "provider" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "publishedAt" TIMESTAMP(3),
    "summary" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchArticle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchStat" (
    "id" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "statKey" TEXT NOT NULL,
    "sampleKey" TEXT NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "hits" INTEGER,
    "value" DECIMAL(10,2),
    "provider" TEXT NOT NULL,
    "season" INTEGER,
    "throughWeek" INTEGER,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "gameLog" JSONB,

    CONSTRAINT "ResearchStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Injury" (
    "id" TEXT NOT NULL,
    "nflGameId" TEXT,
    "subjectKey" TEXT NOT NULL,
    "playerName" TEXT NOT NULL,
    "teamAbbrev" TEXT,
    "position" TEXT,
    "status" TEXT NOT NULL,
    "practiceStatus" TEXT,
    "detail" TEXT,
    "provider" TEXT NOT NULL,
    "reportedAt" TIMESTAMP(3) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Injury_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Weather" (
    "id" TEXT NOT NULL,
    "nflGameId" TEXT NOT NULL,
    "indoor" BOOLEAN NOT NULL DEFAULT false,
    "temperatureF" INTEGER,
    "windMph" INTEGER,
    "precipitationChance" INTEGER,
    "conditions" TEXT,
    "alerts" TEXT,
    "provider" TEXT NOT NULL,
    "forecastFor" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Weather_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchSummary" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "caseFor" TEXT[],
    "caseAgainst" TEXT[],
    "bottomLine" TEXT NOT NULL,
    "sourceRefs" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalPick" (
    "id" TEXT NOT NULL,
    "seasonYear" INTEGER NOT NULL,
    "weekNumber" INTEGER NOT NULL,
    "nflWeekId" TEXT,
    "userId" TEXT,
    "bettorName" TEXT NOT NULL,
    "pickText" TEXT NOT NULL,
    "americanOdds" INTEGER NOT NULL,
    "matchupText" TEXT,
    "outcomeText" TEXT,
    "result" "LegResult" NOT NULL,
    "sourceSheet" TEXT NOT NULL,
    "sourceRow" INTEGER NOT NULL,
    "sourceCol" INTEGER NOT NULL,
    "importId" TEXT NOT NULL,
    "corrected" BOOLEAN NOT NULL DEFAULT false,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HistoricalPick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalImport" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT,
    "status" "ImportStatus" NOT NULL DEFAULT 'PREVIEW',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "seasonsFound" INTEGER NOT NULL DEFAULT 0,
    "weeksFound" INTEGER NOT NULL DEFAULT 0,
    "uniquePicksFound" INTEGER NOT NULL DEFAULT 0,
    "duplicatesExcluded" INTEGER NOT NULL DEFAULT 0,
    "usersMatched" INTEGER NOT NULL DEFAULT 0,
    "weekOffsFound" INTEGER NOT NULL DEFAULT 0,
    "overridesApplied" INTEGER NOT NULL DEFAULT 0,
    "needsReviewCount" INTEGER NOT NULL DEFAULT 0,
    "previewJson" JSONB,

    CONSTRAINT "HistoricalImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportConflict" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "seasonYear" INTEGER,
    "weekNumber" INTEGER,
    "bettorName" TEXT,
    "field" TEXT,
    "rawValue" TEXT,
    "acceptedValue" TEXT,
    "resolution" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportConflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalCorrection" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "seasonYear" INTEGER,
    "weekNumber" INTEGER,
    "bettorName" TEXT,
    "entityId" TEXT,
    "field" TEXT NOT NULL,
    "originalValue" TEXT,
    "correctedValue" TEXT NOT NULL,
    "status" "CorrectionStatus" NOT NULL DEFAULT 'APPROVED',
    "reason" TEXT NOT NULL,
    "canonical" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "HistoricalCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminOverride" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "originalValue" TEXT,
    "overrideValue" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "CorrectionStatus" NOT NULL DEFAULT 'APPROVED',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "AdminOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "summary" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "dedupeKey" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklyRecap" (
    "id" TEXT NOT NULL,
    "nflWeekId" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "bodyJson" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeeklyRecap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Award" (
    "id" TEXT NOT NULL,
    "awardKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "seasonYear" INTEGER,
    "weekNumber" INTEGER,
    "userId" TEXT,
    "detail" TEXT,
    "value" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Award_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AwardDefinition" (
    "id" TEXT NOT NULL,
    "awardKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "AwardDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_displayName_key" ON "User"("displayName");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_legacyName_key" ON "User"("legacyName");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Season_year_key" ON "Season"("year");

-- CreateIndex
CREATE INDEX "NFLWeek_status_idx" ON "NFLWeek"("status");

-- CreateIndex
CREATE UNIQUE INDEX "NFLWeek_seasonId_weekNumber_key" ON "NFLWeek"("seasonId", "weekNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Team_abbreviation_key" ON "Team"("abbreviation");

-- CreateIndex
CREATE INDEX "NFLGame_nflWeekId_kickoffAt_idx" ON "NFLGame"("nflWeekId", "kickoffAt");

-- CreateIndex
CREATE UNIQUE INDEX "NFLGame_nflWeekId_providerGameId_key" ON "NFLGame"("nflWeekId", "providerGameId");

-- CreateIndex
CREATE UNIQUE INDEX "SportsbookEvent_sourceEventId_key" ON "SportsbookEvent"("sourceEventId");

-- CreateIndex
CREATE UNIQUE INDEX "Market_selectionIdentity_key" ON "Market"("selectionIdentity");

-- CreateIndex
CREATE INDEX "Market_eventId_category_idx" ON "Market"("eventId", "category");

-- CreateIndex
CREATE INDEX "Market_lastVerifiedAt_idx" ON "Market"("lastVerifiedAt");

-- CreateIndex
CREATE INDEX "MarketSnapshot_marketId_observedAt_idx" ON "MarketSnapshot"("marketId", "observedAt");

-- CreateIndex
CREATE INDEX "ReaderRun_startedAt_idx" ON "ReaderRun"("startedAt");

-- CreateIndex
CREATE INDEX "ReaderError_occurredAt_idx" ON "ReaderError"("occurredAt");

-- CreateIndex
CREATE INDEX "WatchedPick_nflWeekId_idx" ON "WatchedPick"("nflWeekId");

-- CreateIndex
CREATE UNIQUE INDEX "WatchedPick_userId_marketId_key" ON "WatchedPick"("userId", "marketId");

-- CreateIndex
CREATE INDEX "Pick_nflWeekId_userId_state_idx" ON "Pick"("nflWeekId", "userId", "state");

-- CreateIndex
CREATE INDEX "Pick_marketId_idx" ON "Pick"("marketId");

-- CreateIndex
CREATE INDEX "PickChange_pickId_idx" ON "PickChange"("pickId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchupReservation_pickId_key" ON "MatchupReservation"("pickId");

-- CreateIndex
CREATE INDEX "MatchupReservation_userId_idx" ON "MatchupReservation"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchupReservation_nflWeekId_nflGameId_key" ON "MatchupReservation"("nflWeekId", "nflGameId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchupReservation_nflWeekId_userId_key" ON "MatchupReservation"("nflWeekId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "OfficialTicket_nflWeekId_key" ON "OfficialTicket"("nflWeekId");

-- CreateIndex
CREATE UNIQUE INDEX "OfficialTicketLeg_pickId_key" ON "OfficialTicketLeg"("pickId");

-- CreateIndex
CREATE INDEX "OfficialTicketLeg_userId_idx" ON "OfficialTicketLeg"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OfficialTicketLeg_ticketId_legIndex_key" ON "OfficialTicketLeg"("ticketId", "legIndex");

-- CreateIndex
CREATE INDEX "ResultAudit_legId_idx" ON "ResultAudit"("legId");

-- CreateIndex
CREATE UNIQUE INDEX "Parlay_nflWeekId_key" ON "Parlay"("nflWeekId");

-- CreateIndex
CREATE INDEX "ResearchArticle_marketId_idx" ON "ResearchArticle"("marketId");

-- CreateIndex
CREATE INDEX "ResearchArticle_subjectKey_idx" ON "ResearchArticle"("subjectKey");

-- CreateIndex
CREATE INDEX "ResearchStat_subjectKey_idx" ON "ResearchStat"("subjectKey");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchStat_subjectKey_statKey_sampleKey_provider_key" ON "ResearchStat"("subjectKey", "statKey", "sampleKey", "provider");

-- CreateIndex
CREATE INDEX "Injury_subjectKey_idx" ON "Injury"("subjectKey");

-- CreateIndex
CREATE INDEX "Injury_nflGameId_idx" ON "Injury"("nflGameId");

-- CreateIndex
CREATE UNIQUE INDEX "Weather_nflGameId_key" ON "Weather"("nflGameId");

-- CreateIndex
CREATE INDEX "ResearchSummary_marketId_generatedAt_idx" ON "ResearchSummary"("marketId", "generatedAt");

-- CreateIndex
CREATE INDEX "HistoricalPick_userId_idx" ON "HistoricalPick"("userId");

-- CreateIndex
CREATE INDEX "HistoricalPick_seasonYear_weekNumber_idx" ON "HistoricalPick"("seasonYear", "weekNumber");

-- CreateIndex
CREATE UNIQUE INDEX "HistoricalPick_seasonYear_weekNumber_bettorName_key" ON "HistoricalPick"("seasonYear", "weekNumber", "bettorName");

-- CreateIndex
CREATE INDEX "ImportConflict_importId_idx" ON "ImportConflict"("importId");

-- CreateIndex
CREATE INDEX "HistoricalCorrection_status_idx" ON "HistoricalCorrection"("status");

-- CreateIndex
CREATE UNIQUE INDEX "HistoricalCorrection_entityType_seasonYear_weekNumber_betto_key" ON "HistoricalCorrection"("entityType", "seasonYear", "weekNumber", "bettorName", "field");

-- CreateIndex
CREATE UNIQUE INDEX "AdminOverride_entityType_entityId_field_key" ON "AdminOverride"("entityType", "entityId", "field");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyRecap_nflWeekId_key" ON "WeeklyRecap"("nflWeekId");

-- CreateIndex
CREATE INDEX "Award_scope_seasonYear_weekNumber_idx" ON "Award"("scope", "seasonYear", "weekNumber");

-- CreateIndex
CREATE UNIQUE INDEX "AwardDefinition_awardKey_key" ON "AwardDefinition"("awardKey");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NFLWeek" ADD CONSTRAINT "NFLWeek_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NFLGame" ADD CONSTRAINT "NFLGame_nflWeekId_fkey" FOREIGN KEY ("nflWeekId") REFERENCES "NFLWeek"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NFLGame" ADD CONSTRAINT "NFLGame_homeTeamId_fkey" FOREIGN KEY ("homeTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NFLGame" ADD CONSTRAINT "NFLGame_awayTeamId_fkey" FOREIGN KEY ("awayTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SportsbookEvent" ADD CONSTRAINT "SportsbookEvent_nflGameId_fkey" FOREIGN KEY ("nflGameId") REFERENCES "NFLGame"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Market" ADD CONSTRAINT "Market_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "SportsbookEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketSnapshot" ADD CONSTRAINT "MarketSnapshot_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketSnapshot" ADD CONSTRAINT "MarketSnapshot_readerRunId_fkey" FOREIGN KEY ("readerRunId") REFERENCES "ReaderRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReaderRun" ADD CONSTRAINT "ReaderRun_nflWeekId_fkey" FOREIGN KEY ("nflWeekId") REFERENCES "NFLWeek"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReaderError" ADD CONSTRAINT "ReaderError_readerRunId_fkey" FOREIGN KEY ("readerRunId") REFERENCES "ReaderRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchedPick" ADD CONSTRAINT "WatchedPick_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchedPick" ADD CONSTRAINT "WatchedPick_nflWeekId_fkey" FOREIGN KEY ("nflWeekId") REFERENCES "NFLWeek"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchedPick" ADD CONSTRAINT "WatchedPick_nflGameId_fkey" FOREIGN KEY ("nflGameId") REFERENCES "NFLGame"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchedPick" ADD CONSTRAINT "WatchedPick_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pick" ADD CONSTRAINT "Pick_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pick" ADD CONSTRAINT "Pick_nflWeekId_fkey" FOREIGN KEY ("nflWeekId") REFERENCES "NFLWeek"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pick" ADD CONSTRAINT "Pick_nflGameId_fkey" FOREIGN KEY ("nflGameId") REFERENCES "NFLGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pick" ADD CONSTRAINT "Pick_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickChange" ADD CONSTRAINT "PickChange_pickId_fkey" FOREIGN KEY ("pickId") REFERENCES "Pick"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchupReservation" ADD CONSTRAINT "MatchupReservation_nflWeekId_fkey" FOREIGN KEY ("nflWeekId") REFERENCES "NFLWeek"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchupReservation" ADD CONSTRAINT "MatchupReservation_nflGameId_fkey" FOREIGN KEY ("nflGameId") REFERENCES "NFLGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchupReservation" ADD CONSTRAINT "MatchupReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchupReservation" ADD CONSTRAINT "MatchupReservation_pickId_fkey" FOREIGN KEY ("pickId") REFERENCES "Pick"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficialTicket" ADD CONSTRAINT "OfficialTicket_nflWeekId_fkey" FOREIGN KEY ("nflWeekId") REFERENCES "NFLWeek"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficialTicketLeg" ADD CONSTRAINT "OfficialTicketLeg_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "OfficialTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficialTicketLeg" ADD CONSTRAINT "OfficialTicketLeg_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficialTicketLeg" ADD CONSTRAINT "OfficialTicketLeg_pickId_fkey" FOREIGN KEY ("pickId") REFERENCES "Pick"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResultAudit" ADD CONSTRAINT "ResultAudit_legId_fkey" FOREIGN KEY ("legId") REFERENCES "OfficialTicketLeg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResultAudit" ADD CONSTRAINT "ResultAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Parlay" ADD CONSTRAINT "Parlay_nflWeekId_fkey" FOREIGN KEY ("nflWeekId") REFERENCES "NFLWeek"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Injury" ADD CONSTRAINT "Injury_nflGameId_fkey" FOREIGN KEY ("nflGameId") REFERENCES "NFLGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Weather" ADD CONSTRAINT "Weather_nflGameId_fkey" FOREIGN KEY ("nflGameId") REFERENCES "NFLGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalPick" ADD CONSTRAINT "HistoricalPick_nflWeekId_fkey" FOREIGN KEY ("nflWeekId") REFERENCES "NFLWeek"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalPick" ADD CONSTRAINT "HistoricalPick_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalPick" ADD CONSTRAINT "HistoricalPick_importId_fkey" FOREIGN KEY ("importId") REFERENCES "HistoricalImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportConflict" ADD CONSTRAINT "ImportConflict_importId_fkey" FOREIGN KEY ("importId") REFERENCES "HistoricalImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalCorrection" ADD CONSTRAINT "HistoricalCorrection_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyRecap" ADD CONSTRAINT "WeeklyRecap_nflWeekId_fkey" FOREIGN KEY ("nflWeekId") REFERENCES "NFLWeek"("id") ON DELETE CASCADE ON UPDATE CASCADE;
