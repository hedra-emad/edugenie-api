import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { CoachService } from './coach.service';
import { CoachMissionsService } from './coach-missions.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

describe('AiController', () => {
  let controller: AiController;
  const aiService = {
    streamLessonChat: jest.fn(),
    streamCourseChat: jest.fn(),
    streamRoadmap: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiController],
      providers: [
        { provide: AiService, useValue: aiService },
        { provide: CoachService, useValue: {} },
        { provide: CoachMissionsService, useValue: {} },
      ],
    })
      // The controller is guarded by JwtAuthGuard + ThrottlerGuard, whose DI
      // isn't wired in this lightweight unit test — stub them out.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AiController>(AiController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('streams streamLessonChat tokens as SSE frames', async () => {
    // streamLessonChat returns an AsyncGenerator — the controller consumes it
    // via Symbol.asyncIterator (ai.controller.ts:64), so the mock must be async.
    async function* gen() {
      yield 'hi ';
      yield 'there';
    }
    aiService.streamLessonChat.mockReturnValue(gen());

    const writes: string[] = [];
    const res = {
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn((chunk: string) => writes.push(chunk)),
      end: jest.fn(),
    } as any;

    await controller.chat(
      'lesson1',
      { message: 'hello' },
      { userId: 'u1' },
      res,
    );

    expect(aiService.streamLessonChat).toHaveBeenCalledWith(
      'lesson1',
      'u1',
      'hello',
      undefined,
    );
    // two token frames + a done frame, then the response is ended
    expect(writes).toEqual([
      `data: ${JSON.stringify({ type: 'token', value: 'hi ' })}\n\n`,
      `data: ${JSON.stringify({ type: 'token', value: 'there' })}\n\n`,
      `data: ${JSON.stringify({ type: 'done' })}\n\n`,
    ]);
    expect(res.end).toHaveBeenCalled();
  });
});
