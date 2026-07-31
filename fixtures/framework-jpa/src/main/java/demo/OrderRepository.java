package demo;

import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface OrderRepository extends JpaRepository<OrderEntity, Long> {
  List<OrderEntity> findByCustomerId(Long customerId);

  long countByCustomerId(Long customerId);
}
