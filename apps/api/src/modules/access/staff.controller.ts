import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsBoolean, IsEmail, IsIn, IsOptional, IsString, IsUUID, Matches, MinLength } from 'class-validator';
import { CurrentStaff, Permissions, Staff, StaffGuard } from '../../common/auth';
import { hashPassword } from '../../common/crypto';
import { AppError, forbidden, notFound } from '../../common/errors';
import { AuditService, PrismaService } from '../../common/infra';
import { PERMISSIONS } from '../../common/permissions';
import { paged, PageQuery, paging } from '../../common/util';

class CreateStaffDto {
  @IsEmail() email: string;
  @IsString() @MinLength(2) fullName: string;
  /** Initial password; the user should change it at first sign-in. */
  @IsString() @MinLength(12) password: string;
  @IsArray() @ArrayUnique() @IsUUID('all', { each: true }) roleIds: string[];
  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true }) brandIds?: string[];
  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true }) eventIds?: string[];
  @IsOptional() @IsBoolean() allBrands?: boolean;
}
class UpdateStaffDto {
  @IsOptional() @IsString() @MinLength(2) fullName?: string;
  @IsOptional() @IsIn(['ACTIVE', 'SUSPENDED']) status?: 'ACTIVE' | 'SUSPENDED';
  @IsOptional() @IsString() @MinLength(12) password?: string;
  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true }) roleIds?: string[];
  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true }) brandIds?: string[];
  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true }) eventIds?: string[];
  @IsOptional() @IsBoolean() allBrands?: boolean;
}
class RoleDto {
  @IsString() @Matches(/^[a-z][a-z0-9_]{2,40}$/) key: string;
  @IsString() @MinLength(2) name: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() eventScoped?: boolean;
  @IsArray() @ArrayUnique() @IsString({ each: true }) permissions: string[];
}
class UpdateRoleDto {
  @IsOptional() @IsString() @MinLength(2) name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() eventScoped?: boolean;
  @IsOptional() @IsArray() @ArrayUnique() @IsString({ each: true }) permissions?: string[];
}

const userView = {
  id: true, email: true, fullName: true, status: true, allBrands: true, mfaEnabled: true, lastLoginAt: true, createdAt: true,
  roles: { select: { role: { select: { id: true, key: true, name: true } } } },
  brandAssignments: { select: { brand: { select: { id: true, name: true } } } },
  eventAssignments: { select: { event: { select: { id: true, name: true } } } },
} as const;

@ApiTags('Admin · Staff & Permissions')
@ApiBearerAuth()
@Controller('v1/admin')
@UseGuards(StaffGuard)
export class StaffController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  /** A non-platform admin may only see staff who work on at least one of their brands. */
  private visibleUsers(staff: Staff) {
    return staff.allBrands ? {} : { allBrands: false, brandAssignments: { some: { brandId: { in: staff.brandIds } } } };
  }

  /** Blocks privilege escalation: you cannot grant a brand or permission you do not hold yourself. */
  private async assertGrantable(staff: Staff, dto: { roleIds?: string[]; brandIds?: string[]; allBrands?: boolean }) {
    if (dto.allBrands && !staff.allBrands) throw forbidden('Only platform-wide administrators can grant access to all brands');
    if (!staff.allBrands) {
      const outside = (dto.brandIds ?? []).filter((b) => !staff.brandIds.includes(b));
      if (outside.length) throw forbidden('You cannot assign staff to brands you do not manage');
    }
    if (dto.roleIds?.length) {
      const roles = await this.prisma.role.findMany({ where: { id: { in: dto.roleIds } }, include: { permissions: { include: { permission: true } } } });
      if (roles.length !== dto.roleIds.length) throw new AppError('ROLE_NOT_FOUND', 'One or more roles do not exist', 400);
      for (const r of roles) {
        const extra = r.permissions.map((p) => p.permission.key).filter((k) => !staff.permissions.has(k));
        if (extra.length) throw forbidden(`You cannot grant the role "${r.name}" because it contains permissions you do not hold`);
      }
    }
  }

  @Get('staff')
  @Permissions('staff.read')
  async list(@CurrentStaff() staff: Staff, @Query() q: PageQuery) {
    const where = {
      deletedAt: null,
      ...this.visibleUsers(staff),
      ...(q.brandId ? { brandAssignments: { some: { brandId: q.brandId } } } : {}),
      ...(q.q ? { OR: [{ email: { contains: q.q, mode: 'insensitive' as const } }, { fullName: { contains: q.q, mode: 'insensitive' as const } }] } : {}),
    };
    if (q.brandId && !staff.allBrands && !staff.brandIds.includes(q.brandId)) throw forbidden();
    const { skip, take } = paging(q);
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({ where, select: userView, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.user.count({ where }),
    ]);
    return paged(items, total, q);
  }

  @Post('staff')
  @Permissions('staff.manage')
  async create(@CurrentStaff() staff: Staff, @Body() dto: CreateStaffDto) {
    await this.assertGrantable(staff, dto);
    if (!dto.allBrands && !dto.brandIds?.length) throw new AppError('BRAND_REQUIRED', 'Assign at least one brand, or grant platform-wide access', 400);
    const user = await this.prisma.user.create({
      data: {
        email: dto.email.trim().toLowerCase(),
        fullName: dto.fullName,
        passwordHash: await hashPassword(dto.password),
        allBrands: dto.allBrands ?? false,
        roles: { create: dto.roleIds.map((roleId) => ({ roleId })) },
        brandAssignments: { create: (dto.brandIds ?? []).map((brandId) => ({ brandId })) },
        eventAssignments: { create: (dto.eventIds ?? []).map((eventId) => ({ eventId })) },
      },
      select: userView,
    });
    await this.audit.record({
      actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, action: 'staff.create', entityType: 'user', entityId: user.id,
      after: { email: user.email, roleIds: dto.roleIds, brandIds: dto.brandIds, allBrands: dto.allBrands ?? false },
    });
    return user;
  }

  @Patch('staff/:id')
  @Permissions('staff.manage')
  async update(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStaffDto) {
    const target = await this.prisma.user.findFirst({ where: { id, deletedAt: null, ...this.visibleUsers(staff) }, select: userView });
    if (!target) throw notFound('Staff member');
    await this.assertGrantable(staff, dto);
    if (!staff.allBrands) {
      // A brand admin must not strip assignments for brands they cannot see.
      const foreign = await this.prisma.userBrandAssignment.count({ where: { userId: id, brandId: { notIn: staff.brandIds } } });
      if (foreign && dto.brandIds) throw forbidden('This user also works on brands you do not manage; ask a platform administrator');
    }
    if (id === staff.userId && dto.status === 'SUSPENDED') throw new AppError('SELF_SUSPEND', 'You cannot suspend your own account', 400);

    const user = await this.prisma.$transaction(async (tx) => {
      if (dto.roleIds) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.createMany({ data: dto.roleIds.map((roleId) => ({ userId: id, roleId })) });
      }
      if (dto.brandIds) {
        await tx.userBrandAssignment.deleteMany({ where: { userId: id } });
        await tx.userBrandAssignment.createMany({ data: dto.brandIds.map((brandId) => ({ userId: id, brandId })) });
      }
      if (dto.eventIds) {
        await tx.userEventAssignment.deleteMany({ where: { userId: id } });
        await tx.userEventAssignment.createMany({ data: dto.eventIds.map((eventId) => ({ userId: id, eventId })) });
      }
      if (dto.status === 'SUSPENDED' || dto.password) {
        await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      return tx.user.update({
        where: { id },
        data: {
          fullName: dto.fullName,
          status: dto.status,
          allBrands: dto.allBrands,
          passwordHash: dto.password ? await hashPassword(dto.password) : undefined,
        },
        select: userView,
      });
    });
    await this.audit.record({
      actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, action: 'staff.update', entityType: 'user', entityId: id,
      before: target, after: { ...dto, password: dto.password ? '[changed]' : undefined },
    });
    return user;
  }

  @Delete('staff/:id')
  @Permissions('staff.manage')
  async remove(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    if (id === staff.userId) throw new AppError('SELF_DELETE', 'You cannot delete your own account', 400);
    const target = await this.prisma.user.findFirst({ where: { id, deletedAt: null, ...this.visibleUsers(staff) } });
    if (!target) throw notFound('Staff member');
    // Soft delete: audit history keeps pointing at a real user row.
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { deletedAt: new Date(), status: 'SUSPENDED', email: `deleted+${id}@invalid.local` } }),
      this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, action: 'staff.delete', entityType: 'user', entityId: id, before: { email: target.email } });
    return { ok: true };
  }

  @Get('permissions')
  @Permissions('staff.read')
  permissions() {
    return this.prisma.permission.findMany({ orderBy: [{ group: 'asc' }, { key: 'asc' }] });
  }

  @Get('roles')
  @Permissions('staff.read')
  async roles() {
    const roles = await this.prisma.role.findMany({
      include: { permissions: { include: { permission: true } }, _count: { select: { users: true } } },
      orderBy: { name: 'asc' },
    });
    return roles.map((r) => ({
      id: r.id, key: r.key, name: r.name, description: r.description, isSystem: r.isSystem, eventScoped: r.eventScoped,
      userCount: r._count.users, permissions: r.permissions.map((p) => p.permission.key).sort(),
    }));
  }

  private async permissionIds(keys: string[]) {
    const unknown = keys.filter((k) => !(k in PERMISSIONS));
    if (unknown.length) throw new AppError('UNKNOWN_PERMISSION', `Unknown permissions: ${unknown.join(', ')}`, 400);
    const rows = await this.prisma.permission.findMany({ where: { key: { in: keys } } });
    return rows.map((r) => r.id);
  }

  @Post('roles')
  @Permissions('roles.manage')
  async createRole(@CurrentStaff() staff: Staff, @Body() dto: RoleDto) {
    const ids = await this.permissionIds(dto.permissions);
    const role = await this.prisma.role.create({
      data: { key: dto.key, name: dto.name, description: dto.description, eventScoped: dto.eventScoped ?? false, permissions: { create: ids.map((permissionId) => ({ permissionId })) } },
    });
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, action: 'role.create', entityType: 'role', entityId: role.id, after: dto });
    return role;
  }

  @Patch('roles/:id')
  @Permissions('roles.manage')
  async updateRole(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoleDto) {
    const before = await this.prisma.role.findUnique({ where: { id }, include: { permissions: { include: { permission: true } } } });
    if (!before) throw notFound('Role');
    if (before.key === 'super_admin' && dto.permissions) {
      throw new AppError('ROLE_PROTECTED', 'The Super Administrator role always holds every permission', 400);
    }
    const ids = dto.permissions ? await this.permissionIds(dto.permissions) : null;
    const role = await this.prisma.$transaction(async (tx) => {
      if (ids) {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        await tx.rolePermission.createMany({ data: ids.map((permissionId) => ({ roleId: id, permissionId })) });
      }
      return tx.role.update({ where: { id }, data: { name: dto.name, description: dto.description, eventScoped: dto.eventScoped } });
    });
    await this.audit.record({
      actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, action: 'role.update', entityType: 'role', entityId: id,
      before: { permissions: before.permissions.map((p) => p.permission.key) }, after: dto,
    });
    return role;
  }

  @Delete('roles/:id')
  @Permissions('roles.manage')
  async deleteRole(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    const role = await this.prisma.role.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
    if (!role) throw notFound('Role');
    if (role.isSystem) throw new AppError('ROLE_PROTECTED', 'System roles cannot be deleted', 400);
    if (role._count.users) throw new AppError('ROLE_IN_USE', 'Remove this role from all staff before deleting it', 409);
    await this.prisma.role.delete({ where: { id } });
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, action: 'role.delete', entityType: 'role', entityId: id, before: { key: role.key } });
    return { ok: true };
  }
}
