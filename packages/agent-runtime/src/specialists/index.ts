export * from './specialist-interface.js';
export * from './mathematical-specialist.js';
export * from './analysis-specialist.js';
export * from './verification-specialist.js';
export * from './researcher-specialist.js';
export * from './coder-specialist.js';
export * from './browser-specialist.js';
export * from './document-specialist.js';
export * from './planner-specialist.js';
export * from './automation-specialist.js';
export * from './synthesizer-specialist.js';
export * from './specialist-registry.js';

import { SpecialistRegistry } from './specialist-registry.js';
import { MathematicalSpecialistAgent } from './mathematical-specialist.js';
import { VerificationSpecialistAgent } from './verification-specialist.js';
import { ResearcherSpecialistAgent } from './researcher-specialist.js';
import { CoderSpecialistAgent } from './coder-specialist.js';
import { BrowserSpecialistAgent } from './browser-specialist.js';
import { DocumentSpecialistAgent } from './document-specialist.js';
import { PlannerSpecialistAgent } from './planner-specialist.js';
import { AutomationSpecialistAgent } from './automation-specialist.js';
import { SynthesizerSpecialistAgent } from './synthesizer-specialist.js';

export function createAutonomousSpecialistRegistry(toolGateway?: any): SpecialistRegistry {
  const registry = new SpecialistRegistry();
  registry.registerSpecialist(new PlannerSpecialistAgent(), 'IMPLEMENTED_LOCALLY');
  registry.registerSpecialist(new ResearcherSpecialistAgent(toolGateway), 'IMPLEMENTED_LOCALLY');
  registry.registerSpecialist(new CoderSpecialistAgent(toolGateway), 'IMPLEMENTED_LOCALLY');
  registry.registerSpecialist(new MathematicalSpecialistAgent(toolGateway), 'IMPLEMENTED_LOCALLY');
  registry.registerSpecialist(new DocumentSpecialistAgent(), 'IMPLEMENTED_LOCALLY');
  registry.registerSpecialist(new BrowserSpecialistAgent(toolGateway), 'IMPLEMENTED_LOCALLY');
  registry.registerSpecialist(new AutomationSpecialistAgent(), 'IMPLEMENTED_LOCALLY');
  registry.registerSpecialist(new VerificationSpecialistAgent(), 'IMPLEMENTED_LOCALLY');
  registry.registerSpecialist(new SynthesizerSpecialistAgent(), 'IMPLEMENTED_LOCALLY');
  return registry;
}
