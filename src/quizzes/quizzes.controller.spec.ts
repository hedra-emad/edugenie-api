import { Test, TestingModule } from '@nestjs/testing';
import { QuizzesController } from './quizzes.controller';
import { QuizzesService } from './quizzes.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreateQuizDto } from './dto/create-quiz.dto';

describe('QuizzesController', () => {
  let controller: QuizzesController;

  const quizzesServiceMock = {
    saveQuizConfig: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [QuizzesController],
      providers: [{ provide: QuizzesService, useValue: quizzesServiceMock }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<QuizzesController>(QuizzesController);
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('generateQuizConfig', () => {
    it('forwards the dto and the current instructor id to quizzesService.saveQuizConfig', async () => {
      const dto = { sectionId: 'section-1' } as CreateQuizDto;
      const saved = { message: 'ok', quiz: { id: 'quiz-1' } };
      quizzesServiceMock.saveQuizConfig.mockResolvedValue(saved);

      const result = await controller.generateQuizConfig(dto, {
        userId: 'instructor-1',
      });

      expect(quizzesServiceMock.saveQuizConfig).toHaveBeenCalledWith(
        dto,
        'instructor-1',
      );
      expect(result).toBe(saved);
    });
  });
});
