import { Injectable } from '@nestjs/common';

import { IOrgRepo, IUserRepo } from '../../../DAL/index.js';
import { IAuthService } from '../../../infra/index.js';

// Entity Types
import type { Org, OrgID, UserID } from 'domain-model';
import { Role } from 'domain-model';

// DTO Types
import type { CreateOneOrgDTO } from 'domain-model';

// Service layer Exceptions
import { NotFoundException } from '../../../exceptions/index.js';

@Injectable()
export class OrgService {
  constructor(
    private readonly orgRepo: IOrgRepo,
    private readonly userRepo: IUserRepo,
    private readonly authService: IAuthService,
  ) {}

  /**
   * Get Org data of given orgID from data source.
   */
  async getOrg(orgID: OrgID): Promise<Org> {
    const org = await this.orgRepo.getOne(orgID);
    if (org === null)
      throw new NotFoundException(`Org with orgID '${orgID}' is not found!`);

    return org;
  }

  /**
   * Get a user's Org Entity object back if they belong to an Org
   */
  async getUserOrg(userID: UserID): Promise<Org> {
    const org = await this.orgRepo.getUserOrg(userID);
    if (org === null)
      throw new NotFoundException(`User '${userID}' does not have an Org!`);

    return org;
  }

  /**
   * Create a new Organisation, and set creator as the Org Owner
   */
  async createOrg(
    userID: UserID,
    createOneOrgDTO: CreateOneOrgDTO,
  ): Promise<Org> {
    const org = await this.orgRepo.createOne(createOneOrgDTO);

    // Update User Entity to add Role and OrgID
    await this.userRepo.updateOne(userID, {
      orgID: org.id,
      role: Role.OrgOwner,
    });

    // Set Org creator as the Org Owner
    await this.authService.setCustomClaims(userID, { roles: [Role.OrgOwner] });

    return org;
  }
}
