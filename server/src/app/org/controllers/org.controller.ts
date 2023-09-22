import { Controller, Get, Post, Body } from '@nestjs/common';

import { OrgService } from '../services/org.service.js';

import {
  GuardWithRBAC,
  AllowAllRoles,
  NoRoleRequired,
  JWT_uid,
} from '../../../rbac/index.js';

// Entity Types
import type { FirebaseAuthUID } from 'domain-model';

// DTO Types
import type { ReadOneOrgDTO } from 'domain-model';

// DTO Validators
import { ValidatedCreateOneOrgDTO } from '../dto-validation/ValidatedCreateOneOrgDTO.js';

// Exception Filters
import { UseHttpControllerFilters } from '../../../exception-filters/index.js';

@Controller('org')
@GuardWithRBAC()
@UseHttpControllerFilters
export class OrgController {
  constructor(private readonly orgService: OrgService) {}

  /**
   * Get the given user's org
   */
  @Get('self')
  @AllowAllRoles
  async getSelfOrg(@JWT_uid userID: FirebaseAuthUID): Promise<ReadOneOrgDTO> {
    return this.orgService.getUserOrg(userID).then((org) => ({ org }));
  }

  /**
   * Create a new Organisation, and set creator as the Org Owner
   */
  @Post('create')
  // A user does not have any roles since they do not belong to any organisation
  // when creating a new organisation, therefore no role is required.
  @NoRoleRequired
  async createOrg(
    @JWT_uid userID: FirebaseAuthUID,
    @Body() createOneOrgDTO: ValidatedCreateOneOrgDTO,
  ): Promise<ReadOneOrgDTO> {
    return this.orgService
      .createOrg(userID, createOneOrgDTO)
      .then((org) => ({ org }));
  }
}
