import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { QuizzesService } from './quizzes.service';
import { Quiz } from './schema/quiz.schema';
import { QuizAttempt } from './schema/quiz-attempt.schema';
import { Notification } from '../notifications/schema/notification.schema';
import { Enrollment } from '../enrollments/schema/enrollment.schema';
import { Course } from '../courses/schema/course.schema';
import { User } from '../users/schema/user.schema';
import { EnrollmentsService } from '../enrollments/enrollments.service';
import { ProgressService } from '../progress/progress.service';
import { AiService } from '../ai/ai.service';
import { RemediationService } from '../ai/remediation.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CertificatesService } from '../certificates/certificates.service';
import { Types } from 'mongoose';
import { BadRequestException } from '@nestjs/common';

describe('QuizzesService', () => {
  let service: QuizzesService;

  const mockQuizModel = {
    findById: jest.fn(),
  };

  const mockQuizAttemptModel = {
    findById: jest.fn(),
    countDocuments: jest.fn(),
    updateOne: jest.fn(),
  };

  const mockNotificationModel = {
    create: jest.fn(),
  };

  const mockEnrollmentModel = {
    findOneAndUpdate: jest.fn(),
  };

  const mockCourseModel = {
    findById: jest.fn(),
    findOne: jest.fn(),
  };

  const mockUserModel = {};

  const mockEnrollmentsService = {
    canAccessSection: jest.fn(),
    countEnrollmentsForSection: jest.fn(),
  };

  const mockProgressService = {
    markQuizPassed: jest.fn(),
  };

  const mockAiService = {};

  const mockRemediationService = {
    resolveOnPass: jest.fn(),
  };

  const mockNotificationsService = {};

  const mockCertificatesService = {};

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuizzesService,
        { provide: getModelToken(Quiz.name), useValue: mockQuizModel },
        {
          provide: getModelToken(QuizAttempt.name),
          useValue: mockQuizAttemptModel,
        },
        {
          provide: getModelToken(Notification.name),
          useValue: mockNotificationModel,
        },
        {
          provide: getModelToken(Enrollment.name),
          useValue: mockEnrollmentModel,
        },
        { provide: getModelToken(Course.name), useValue: mockCourseModel },
        { provide: getModelToken(User.name), useValue: mockUserModel },
        { provide: EnrollmentsService, useValue: mockEnrollmentsService },
        { provide: ProgressService, useValue: mockProgressService },
        { provide: AiService, useValue: mockAiService },
        { provide: RemediationService, useValue: mockRemediationService },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: CertificatesService, useValue: mockCertificatesService },
      ],
    }).compile();

    service = module.get<QuizzesService>(QuizzesService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('submitAttempt', () => {
    const sectionId = new Types.ObjectId().toString();
    const studentId = new Types.ObjectId().toString();
    const quizId = new Types.ObjectId().toString();
    const attemptId = new Types.ObjectId().toString();

    const mockQuiz = {
      _id: quizId,
      passingScore: 70,
      maxAttempts: 3,
      questions: [
        { _id: 'q1', correctAnswers: ['A', 'B'] },
        { _id: 'q2', correctAnswers: ['C'] },
      ],
    };

    const createMockAttempt = (overrides = {}) => {
      const attempt = {
        _id: attemptId,
        studentId: new Types.ObjectId(studentId),
        quizId: quizId,
        status: 'in_progress',
        startedAt: new Date(),
        timeLimit: 600,
        attemptNumber: 1,
        save: jest.fn().mockResolvedValue(true),
        ...overrides,
      };
      return attempt;
    };

    it('A fully correct submission scores 100', async () => {
      const attempt = createMockAttempt();
      mockQuizAttemptModel.findById.mockResolvedValue(attempt);
      mockQuizAttemptModel.updateOne.mockResolvedValue({ modifiedCount: 1 });
      mockQuizModel.findById.mockResolvedValue(mockQuiz);
      mockQuizAttemptModel.countDocuments.mockResolvedValue(1);

      mockProgressService.markQuizPassed.mockResolvedValue({
        nextSectionUnlocked: true,
        isCourseCompleted: false,
      });
      mockCourseModel.findOne.mockReturnValue({
        select: jest
          .fn()
          .mockReturnValue({
            lean: jest.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
          }),
      });

      const dto = {
        attemptId,
        answers: [
          { questionId: 'q1', selectedOptionIds: ['B', 'A'] },
          { questionId: 'q2', selectedOptionIds: ['C'] },
        ],
      };

      const result = await service.submitAttempt(sectionId, dto, studentId);

      expect(result.score).toBe(100);
      expect(result.passed).toBe(true);
      expect(result.correctAnswers).toBe(2);
      expect(mockQuizAttemptModel.updateOne).toHaveBeenCalled();
    });

    it('A fully wrong submission scores 0', async () => {
      const attempt = createMockAttempt();
      mockQuizAttemptModel.findById.mockResolvedValue(attempt);
      mockQuizAttemptModel.updateOne.mockResolvedValue({ modifiedCount: 1 });
      mockQuizModel.findById.mockResolvedValue(mockQuiz);
      mockQuizAttemptModel.countDocuments.mockResolvedValue(1);

      const dto = {
        attemptId,
        answers: [
          { questionId: 'q1', selectedOptionIds: ['C'] },
          { questionId: 'q2', selectedOptionIds: ['D'] },
        ],
      };

      const result = await service.submitAttempt(sectionId, dto, studentId);

      expect(result.score).toBe(0);
      expect(result.passed).toBe(false);
      expect(result.correctAnswers).toBe(0);
      expect(mockQuizAttemptModel.updateOne).toHaveBeenCalled();
    });

    it('Submitting after timeLimit has elapsed auto-fails with status expired', async () => {
      // Create an attempt that started 601 seconds ago (limit is 600)
      const pastDate = new Date(Date.now() - 601000);
      const attempt = createMockAttempt({ startedAt: pastDate });

      mockQuizAttemptModel.findById.mockResolvedValue(attempt);
      mockQuizAttemptModel.updateOne.mockResolvedValue({ modifiedCount: 1 });

      const dto = {
        attemptId,
        answers: [
          { questionId: 'q1', selectedOptionIds: ['A', 'B'] },
          { questionId: 'q2', selectedOptionIds: ['C'] },
        ],
      };

      await expect(
        service.submitAttempt(sectionId, dto, studentId),
      ).rejects.toThrow(
        'Time limit exceeded — this attempt has expired and been recorded as failed',
      );

      expect(mockQuizAttemptModel.updateOne).toHaveBeenCalled();
    });

    it('scoring excludes ignored questions', async () => {
      const attempt = createMockAttempt();
      mockQuizAttemptModel.findById.mockResolvedValue(attempt);
      mockQuizAttemptModel.updateOne.mockResolvedValue({ modifiedCount: 1 });
      
      const mockQuizWithIgnored = {
        _id: quizId,
        passingScore: 70,
        maxAttempts: 3,
        questions: [
          { _id: 'q1', correctAnswers: ['A'], isIgnored: false },
          { _id: 'q2', correctAnswers: ['C'], isIgnored: true },
        ],
      };
      mockQuizModel.findById.mockResolvedValue(mockQuizWithIgnored);
      mockQuizAttemptModel.countDocuments.mockResolvedValue(1);

      mockCourseModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
        }),
      });

      const dto = {
        attemptId,
        answers: [
          { questionId: 'q1', selectedOptionIds: ['A'] },
          { questionId: 'q2', selectedOptionIds: ['C'] },
        ],
      };

      const result = await service.submitAttempt(sectionId, dto, studentId);

      expect(result.score).toBe(100);
      expect(result.passed).toBe(true);
      expect(result.correctAnswers).toBe(1);
      expect(result.totalQuestions).toBe(1);
    });
  });

  describe('approveQuiz', () => {
    const quizId = new Types.ObjectId().toString();
    const instructorId = new Types.ObjectId().toString();
    
    // A quiz must retain at least MIN_QUESTIONS_PER_QUIZ (5) active questions to
    // be approvable (quizzes.service.ts:1027-1035), so fixtures carry 5.
    const activeQuestions = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        _id: `q${i + 1}`,
        questionText: `Q${i + 1} Text`,
        type: 'TRUE_FALSE',
        options: ['True', 'False'],
        correctAnswers: ['True'],
        isIgnored: false,
        createdBy: 'AI',
      }));

    it('Approving with editedQuestions omitted behaves as before', async () => {
      const mockQuiz = {
        _id: quizId,
        sectionId: new Types.ObjectId(),
        questions: activeQuestions(5),
        status: 'pending_review',
        save: jest.fn().mockResolvedValue(true),
      };
      
      mockQuizModel.findById = jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockQuiz),
      });
      
      mockCourseModel.findOne = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(),
            instructorId: instructorId,
          }),
        }),
      });
      
      mockEnrollmentsService.countEnrollmentsForSection = jest.fn().mockResolvedValue(5);
      
      const result = await service.approveQuiz(quizId, instructorId, {});

      expect(result.status).toBe('approved');
      expect(mockQuiz.questions.length).toBe(5);
      expect(mockQuiz.save).toHaveBeenCalled();
    });

    it('Approving with a new question adds it with createdBy INSTRUCTOR', async () => {
      const mockQuiz = {
        _id: quizId,
        sectionId: new Types.ObjectId(),
        // 4 existing AI questions; all are re-submitted below so they survive
        // the editedQuestions filter, and the 1 new question makes 5 active.
        questions: activeQuestions(4),
        status: 'pending_review',
        save: jest.fn().mockResolvedValue(true),
      };
      
      mockQuizModel.findById = jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockQuiz),
      });
      
      mockCourseModel.findOne = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(),
            instructorId: instructorId,
          }),
        }),
      });
      
      mockEnrollmentsService.countEnrollmentsForSection = jest.fn().mockResolvedValue(5);
      
      const result = await service.approveQuiz(quizId, instructorId, {
        editedQuestions: [
          ...['q1', 'q2', 'q3', 'q4'].map((questionId) => ({
            questionId,
            questionText: `${questionId.toUpperCase()} Text`,
            type: 'TRUE_FALSE' as any,
            options: ['True', 'False'],
            correctAnswers: ['True'],
            isIgnored: false,
          })),
          {
            questionText: 'Instructor Question',
            type: 'SINGLE_CHOICE' as any,
            options: ['A', 'B'],
            correctAnswers: ['A'],
          },
        ],
      });

      expect(result.status).toBe('approved');
      // 4 re-submitted existing + 1 newly authored = 5.
      expect(mockQuiz.questions.length).toBe(5);
      expect(mockQuiz.questions[4].createdBy).toBe('INSTRUCTOR');
      expect(mockQuiz.save).toHaveBeenCalled();
    });

    it('Approving which would leave zero active questions throws BadRequestException', async () => {
      const mockQuiz = {
        _id: quizId,
        sectionId: new Types.ObjectId(),
        questions: [
          { _id: 'q1', questionText: 'Q1 Text', type: 'TRUE_FALSE', options: ['True', 'False'], correctAnswers: ['True'], isIgnored: false, createdBy: 'AI' }
        ],
        status: 'pending_review',
        save: jest.fn().mockResolvedValue(true),
      };
      
      mockQuizModel.findById = jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockQuiz),
      });
      
      mockCourseModel.findOne = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(),
            instructorId: instructorId,
          }),
        }),
      });
      
      await expect(
        service.approveQuiz(quizId, instructorId, {
          editedQuestions: [
            {
              questionId: 'q1',
              questionText: 'Q1 Text',
              type: 'TRUE_FALSE' as any,
              options: ['True', 'False'],
              correctAnswers: ['True'],
              isIgnored: true,
            }
          ]
        })
      ).rejects.toThrow(BadRequestException);
    });
  });
});
