import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Length, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { CurrentStaff, RateLimit, RateLimitGuard, signStaffToken, Staff, StaffGuard } from '../../common/auth';
import { config } from '../../common/config';
import { decrypt, encrypt, generateTotpSecret, hashPassword, randomToken, sha256, totpUri, verifyPassword, verifyTotp } from '../../common/crypto';
import { AppError } from '../../common/errors';
import { AlertService, AuditService, PrismaService } from '../../common/infra';

class LoginDto {
  @IsEmail() email: string;
  @IsString() @MinLength(1) password: string;
  /** 6-digit TOTP code, required when MFA is enabled on the account. */
  @IsOptional() @IsString() @Length(6, 6) totp?: string;
}
class CodeDto {
  @IsString() @Length(6, 6) code: string;
}
class DisableMfaDto extends CodeDto {
  @IsString() password: string;
}
class ChangePasswordDto {
  @IsString() currentPassword: string;
  @IsString() @MinLength(12) newPassword: string;
}

const COOKIE = 'ctp_rt';
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function setRefreshCookie(res: Response, token: string | null) {
  res.cookie(COOKIE, token ?? '', {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'strict',
    path: '/',
    maxAge: token ? config.refreshTokenTtlSec * 1000 : 0,
  });
}

@ApiTags('Admin · Auth')
@Controller('v1/admin/auth')
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(private prisma: PrismaService, private audit: AuditService, private alerts: AlertService) {}

  /** Password (+ TOTP) login. Returns a short-lived access token; the refresh token is set as an httpOnly cookie. */
  @Post('login')
  @HttpCode(200)
  @RateLimit({ limit: 10, windowSec: 60 })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    const invalid = new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
    if (!user || user.deletedAt) {
      await verifyPassword(dto.password, 'scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '=='); // equalise timing
      throw invalid;
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.', 423);
    }
    if (user.status !== 'ACTIVE') throw new AppError('ACCOUNT_DISABLED', 'This account is not active', 403);

    const passwordOk = await verifyPassword(dto.password, user.passwordHash);
    const mfaOk = !user.mfaEnabled || (!!dto.totp && !!user.mfaSecretEnc && verifyTotp(decrypt(user.mfaSecretEnc), dto.totp));
    if (passwordOk && user.mfaEnabled && !dto.totp) {
      throw new AppError('MFA_REQUIRED', 'Enter the 6-digit code from your authenticator app', 401);
    }
    if (!passwordOk || !mfaOk) {
      const failed = user.failedLoginCount + 1;
      const lock = failed >= MAX_FAILED;
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null },
      });
      await this.audit.record({ actorType: 'USER', actorId: user.id, actorLabel: user.email, action: 'auth.login_failed', metadata: { locked: lock } });
      if (lock) {
        await this.alerts.raise({
          type: 'SUSPICIOUS_LOGIN', severity: 'WARNING', entityType: 'user', entityId: user.id,
          message: `Account ${user.email} locked after ${MAX_FAILED} failed sign-in attempts from ${req.ip}`,
        });
      }
      throw invalid;
    }

    const refreshToken = randomToken(48);
    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: sha256(refreshToken),
        mfaVerified: user.mfaEnabled,
        ip: req.ip,
        userAgent: req.header('user-agent')?.slice(0, 300),
        expiresAt: new Date(Date.now() + config.refreshTokenTtlSec * 1000),
      },
    });
    await this.prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
    await this.audit.record({ actorType: 'USER', actorId: user.id, actorLabel: user.email, action: 'auth.login', entityType: 'session', entityId: session.id });
    setRefreshCookie(res, refreshToken);
    return { accessToken: signStaffToken(user.id, session.id), expiresIn: config.accessTokenTtlSec };
  }

  /** Rotates the refresh token and returns a new access token. */
  @Post('refresh')
  @HttpCode(200)
  @RateLimit({ limit: 60, windowSec: 60 })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = readCookie(req, COOKIE);
    if (!token) throw new AppError('UNAUTHENTICATED', 'No session', 401);
    const session = await this.prisma.session.findUnique({ where: { refreshTokenHash: sha256(token) }, include: { user: true } });
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.user.status !== 'ACTIVE') {
      setRefreshCookie(res, null);
      throw new AppError('UNAUTHENTICATED', 'Session expired', 401);
    }
    const next = randomToken(48);
    await this.prisma.session.update({ where: { id: session.id }, data: { refreshTokenHash: sha256(next), lastUsedAt: new Date() } });
    setRefreshCookie(res, next);
    return { accessToken: signStaffToken(session.userId, session.id), expiresIn: config.accessTokenTtlSec };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = readCookie(req, COOKIE);
    if (token) {
      await this.prisma.session.updateMany({ where: { refreshTokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
    }
    setRefreshCookie(res, null);
    return { ok: true };
  }

  /** The signed-in user, their permissions and the brands they may operate on. */
  @Get('me')
  @ApiBearerAuth()
  @UseGuards(StaffGuard)
  async me(@CurrentStaff() staff: Staff) {
    const [brands, user] = await Promise.all([
      this.prisma.brand.findMany({
        where: staff.allBrands ? {} : { id: { in: staff.brandIds } },
        select: { id: true, name: true, slug: true, status: true, primaryColor: true, logoUrl: true, defaultCurrency: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.user.findUniqueOrThrow({ where: { id: staff.userId }, select: { mfaEnabled: true } }),
    ]);
    return {
      id: staff.userId,
      email: staff.email,
      fullName: staff.fullName,
      allBrands: staff.allBrands,
      roles: staff.roleKeys,
      permissions: [...staff.permissions].sort(),
      eventScoped: staff.eventScoped,
      mfaEnabled: user.mfaEnabled,
      brands,
    };
  }

  /** Starts TOTP enrolment: returns the secret and otpauth:// URI to add to an authenticator app. */
  @Post('mfa/setup')
  @ApiBearerAuth()
  @UseGuards(StaffGuard)
  async mfaSetup(@CurrentStaff() staff: Staff) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: staff.userId } });
    if (user.mfaEnabled) throw new AppError('MFA_ALREADY_ENABLED', 'MFA is already enabled', 409);
    const secret = generateTotpSecret();
    await this.prisma.user.update({ where: { id: user.id }, data: { mfaSecretEnc: encrypt(secret) } });
    return { secret, otpauthUri: totpUri(secret, user.email) };
  }

  @Post('mfa/enable')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(StaffGuard)
  async mfaEnable(@CurrentStaff() staff: Staff, @Body() dto: CodeDto) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: staff.userId } });
    if (!user.mfaSecretEnc || !verifyTotp(decrypt(user.mfaSecretEnc), dto.code)) {
      throw new AppError('MFA_CODE_INVALID', 'The code is not valid', 400);
    }
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: true } }),
      this.prisma.session.update({ where: { id: staff.sessionId }, data: { mfaVerified: true } }),
      // Other sessions were created without a second factor: end them.
      this.prisma.session.updateMany({ where: { userId: user.id, id: { not: staff.sessionId }, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await this.audit.record({ actorType: 'USER', actorId: user.id, actorLabel: user.email, action: 'auth.mfa_enabled' });
    return { mfaEnabled: true };
  }

  @Post('mfa/disable')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(StaffGuard)
  async mfaDisable(@CurrentStaff() staff: Staff, @Body() dto: DisableMfaDto) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: staff.userId } });
    const ok = (await verifyPassword(dto.password, user.passwordHash)) && !!user.mfaSecretEnc && verifyTotp(decrypt(user.mfaSecretEnc), dto.code);
    if (!ok) throw new AppError('MFA_CODE_INVALID', 'Password or code is not valid', 400);
    await this.prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: false, mfaSecretEnc: null } });
    await this.audit.record({ actorType: 'USER', actorId: user.id, actorLabel: user.email, action: 'auth.mfa_disabled' });
    return { mfaEnabled: false };
  }

  @Post('password')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(StaffGuard)
  async changePassword(@CurrentStaff() staff: Staff, @Body() dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: staff.userId } });
    if (!(await verifyPassword(dto.currentPassword, user.passwordHash))) {
      throw new AppError('INVALID_CREDENTIALS', 'Current password is incorrect', 400);
    }
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(dto.newPassword) } }),
      this.prisma.session.updateMany({ where: { userId: user.id, id: { not: staff.sessionId }, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await this.audit.record({ actorType: 'USER', actorId: user.id, actorLabel: user.email, action: 'auth.password_changed' });
    return { ok: true };
  }
}
