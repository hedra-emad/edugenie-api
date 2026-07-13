import { Test, TestingModule } from '@nestjs/testing';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';

describe('ReviewsController', () => {
  let controller: ReviewsController;

  const reviewsServiceMock = {
    getCourseReviews: jest.fn(),
    createReview: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReviewsController],
      providers: [{ provide: ReviewsService, useValue: reviewsServiceMock }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(OptionalJwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ReviewsController>(ReviewsController);
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getCourseReviews', () => {
    it('parses paging query strings to numbers and forwards the current user id', async () => {
      const paginated = { items: [], hasReviewed: false };
      reviewsServiceMock.getCourseReviews.mockResolvedValue(paginated);

      const result = await controller.getCourseReviews('course-1', '2', '5', {
        userId: 'student-1',
      });

      expect(reviewsServiceMock.getCourseReviews).toHaveBeenCalledWith(
        'course-1',
        2,
        5,
        'student-1',
      );
      expect(result).toEqual({ success: true, data: paginated });
    });

    it('defaults to page 1 / limit 10 when paging query is absent', async () => {
      reviewsServiceMock.getCourseReviews.mockResolvedValue({});

      await controller.getCourseReviews('course-1', undefined, undefined, undefined);

      expect(reviewsServiceMock.getCourseReviews).toHaveBeenCalledWith(
        'course-1',
        1,
        10,
        undefined,
      );
    });
  });
});
