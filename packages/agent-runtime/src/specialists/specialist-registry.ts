import {
  SpecialistRole,
  ALL_SPECIALIST_ROLES
} from '../../../contracts/src/index.js';
import { ISpecialistAgent } from './specialist-interface.js';

export type SpecialistOperationalStatus =
  | 'CONTRACT_ONLY'
  | 'IMPLEMENTED_LOCALLY'
  | 'INTEGRATION_TESTED'
  | 'LIVE_STAGING_CERTIFIED'
  | 'PRODUCTION_ENABLED'
  | 'UNAVAILABLE';

export interface SpecialistRegistrationMetadata {
  role: SpecialistRole;
  name: string;
  operationalStatus: SpecialistOperationalStatus;
  agent?: ISpecialistAgent;
  description: string;
}

export class SpecialistRegistry {
  private specialists: Map<SpecialistRole, SpecialistRegistrationMetadata> = new Map();

  constructor() {
    this.initializeCanonicalRoles();
  }

  private initializeCanonicalRoles(): void {
    // Initialize all 9 canonical roles as CONTRACT_ONLY / UNAVAILABLE by default
    for (const role of ALL_SPECIALIST_ROLES) {
      this.specialists.set(role, {
        role,
        name: `${role.charAt(0).toUpperCase() + role.slice(1)} Specialist`,
        operationalStatus: 'UNAVAILABLE',
        description: `Canonical ${role} specialist role defined in M1 contract.`
      });
    }
  }

  /**
   * Registers a concrete specialist agent implementation for a specific role.
   */
  public registerSpecialist(
    agent: ISpecialistAgent,
    operationalStatus: SpecialistOperationalStatus = 'IMPLEMENTED_LOCALLY'
  ): void {
    const existing = this.specialists.get(agent.role);
    this.specialists.set(agent.role, {
      role: agent.role,
      name: agent.name,
      operationalStatus,
      agent,
      description: agent.description || existing?.description || ''
    });
  }

  /**
   * Retrieves the concrete implementation for a role, or undefined if unavailable.
   */
  public getSpecialist(role: SpecialistRole): ISpecialistAgent | undefined {
    const record = this.specialists.get(role);
    return record?.agent;
  }

  /**
   * Checks if a role is implemented and runnable.
   */
  public hasSpecialist(role: SpecialistRole): boolean {
    return this.getSpecialist(role) !== undefined;
  }

  /**
   * Returns operational status for a role.
   */
  public getStatus(role: SpecialistRole): SpecialistOperationalStatus {
    const record = this.specialists.get(role);
    return record?.operationalStatus || 'UNAVAILABLE';
  }

  /**
   * Lists the operational readiness of all 9 specialist roles.
   */
  public listAllRoles(): SpecialistRegistrationMetadata[] {
    return Array.from(this.specialists.values());
  }
}
