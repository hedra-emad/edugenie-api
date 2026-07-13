import { Test, TestingModule } from '@nestjs/testing';
import { EnrollmentsController } from './enrollments.controller';
import { EnrollmentsService } from './enrollments.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { PaginateQueryDto } from '../common/dto/paginate-query.dto';

describe('EnrollmentsController', () => {
  let controller: EnrollmentsController;

  const enrollmentsServiceMock = {
    getMyEnrollments: jest.fn(),
    getMyCourses: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EnrollmentsController],
      providers: [
        { provide: EnrollmentsService, useValue: enrollmentsServiceMock },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<EnrollmentsController>(EnrollmentsController);
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getMyEnrollments', () => {
    it('forwards the current user id and paging query to the service', () => {
      const query: PaginateQueryDto = { page: 1, limit: 10 };
      const page = { items: [], total: 0 };
      enrollmentsServiceMock.getMyEnrollments.mockReturnValue(page);

      const result = controller.getMyEnrollments({ userId: 'student-1' }, query);

      expect(enrollmentsServiceMock.getMyEnrollments).toHaveBeenCalledWith(
        'student-1',
        query,
      );
      expect(result).toBe(page);
    });
  });
});
